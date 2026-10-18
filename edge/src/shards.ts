// Which of the mini's workerd processes holds a site (seoul/README.md,
// "Shards"). workerd runs every object in a process on one thread, so the
// mini runs several, each with its own site databases, and a router in front
// (router.ts) that sends each site's requests to its own. The router and
// every shard compute the same answer here; so does infra's cutover script
// (kr-seongsu-m4/bin/naru-sdk-shard-migrate), which is why the hash is fixed
// and spelled out:
//
//   shard = FNV-1a 32-bit (offset basis 0x811c9dc5, prime 0x01000193) of the
//           site name's UTF-8 bytes, mod the number of shards,
//
// unless the overrides name the site: a site moved to another shard by hand.
// Changing the number of shards moves most sites, so it is a cutover too.

/** FNV-1a, 32 bits, of the text's UTF-8 bytes. */
export function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export interface Shards {
  /** Where each shard listens, shard 0 first, such as http://127.0.0.1:40101. */
  origins: string[];
  /** Sites held somewhere other than their hash says. */
  overrides: Map<string, number>;
}

/** The site's shard, of `count`. */
export function shardOf(
  site: string,
  count: number,
  overrides: ReadonlyMap<string, number> = new Map(),
): number {
  return overrides.get(site) ?? fnv1a32(site) % count;
}

/**
 * The shards, from NARU_SDK_SHARD_ORIGINS (comma-separated) and
 * NARU_SDK_SHARD_OVERRIDES (a JSON object of site to shard). Throws when
 * either is malformed, or an override names a shard there is not: a router or
 * shard that guessed would send a site to an empty database.
 */
export function parseShards(
  origins: string | undefined,
  overrides: string | undefined,
): Shards {
  const list = (origins ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (!list.length) throw new Error("NARU_SDK_SHARD_ORIGINS names no shard.");
  for (const origin of list)
    if (!/^https?:\/\/[^/]+$/.test(origin))
      throw new Error(`NARU_SDK_SHARD_ORIGINS: ${origin} is not an origin.`);
  const given: unknown = overrides?.trim() ? JSON.parse(overrides) : {};
  if (!given || typeof given !== "object" || Array.isArray(given))
    throw new Error("NARU_SDK_SHARD_OVERRIDES is not a JSON object.");
  const moved = new Map<string, number>();
  for (const [site, shard] of Object.entries(given)) {
    if (!Number.isInteger(shard) || shard < 0 || shard >= list.length)
      throw new Error(
        `NARU_SDK_SHARD_OVERRIDES: ${site} names shard ${JSON.stringify(shard)}, of ${list.length}.`,
      );
    moved.set(site, shard as number);
  }
  return { origins: list, overrides: moved };
}

/** What the mini answers at all (seoul.ts); anything else is not found. */
export const SERVED =
  /^\/(?:sdk\/|api\/data\/v1\/|v1\/sites\/|v1\/breakers\/|v1\/notifications\/)/;

const DATA = /^\/api\/data\/v1\/([^/]+)(?:\/|$)/;
const SITES = /^\/v1\/sites\/([^/]+)(?:\/|$)/;

/**
 * The site a request's path names, as the Worker reads it: the data API
 * (website.ts: queries, mutations, reads, media, live connections) and the
 * control plane's site operations (index.ts, route renders among them). Null
 * for any other path, or one whose site is not valid percent-encoding (the
 * Worker refuses those itself, on whichever shard).
 */
export function siteOfPath(pathname: string): string | null {
  const found = DATA.exec(pathname) ?? SITES.exec(pathname);
  if (!found) return null;
  try {
    return decodeURIComponent(found[1]);
  } catch {
    return null;
  }
}

/**
 * /v1/breakers/unnotified merged across shards: each shard's breakers are
 * its own Worker's memory, for the sites it holds, so the union is every
 * site with an unnotified pause.
 */
export function mergeUnnotified(answers: { sites: string[] }[]): {
  sites: string[];
} {
  return { sites: [...new Set(answers.flatMap((answer) => answer.sites))] };
}
