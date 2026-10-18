import { connect } from "cloudflare:sockets";
import { serveSdk, type SdkEnv } from "./sdk";
import {
  mergeUnnotified,
  parseShards,
  SERVED,
  shardOf,
  siteOfPath,
  type Shards,
} from "./shards";

// The mini's front process, on 127.0.0.1:40100, where Caddy, naru's
// containers and Cloudflare's route renders have always called: a workerd
// Worker with no objects and no SQLite, in front of the shards, each a
// workerd running seoul.ts with its own site databases (seoul/README.md,
// "Shards"). It answers /healthz and the SDK's files itself, sends each
// site's requests to the shard that holds it (shards.ts), as they are,
// headers, bodies and WebSockets alike, and asks every shard what only all
// of them know: /healthz/deep, the breakers' unnotified sites and the sites
// with queued notifications.
// Nothing but the default is exported: workerd takes every named export of a
// Worker's main module as an entrypoint.

export interface RouterEnv extends SdkEnv {
  /** Comma-separated: where each shard listens, shard 0 first. */
  NARU_SDK_SHARD_ORIGINS?: string;
  /** JSON, site to shard: sites held elsewhere than their hash says. */
  NARU_SDK_SHARD_OVERRIDES?: string;
}

/** How long a shard that refuses connections (restarting) is tried for. */
const RETRY_MS = 10_000;
const RETRY_INTERVAL_MS = 250;
const PROBE_TIMEOUT_MS = 5_000;

let parsed: { key: string; shards: Shards } | null = null;
function shardsOf(env: RouterEnv): Shards {
  const key = `${env.NARU_SDK_SHARD_ORIGINS}\n${env.NARU_SDK_SHARD_OVERRIDES}`;
  if (parsed?.key !== key)
    parsed = {
      key,
      shards: parseShards(
        env.NARU_SDK_SHARD_ORIGINS,
        env.NARU_SDK_SHARD_OVERRIDES,
      ),
    };
  return parsed.shards;
}

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Whether the shard accepts a connection: refused while it restarts. */
async function listening(origin: string): Promise<boolean> {
  const { hostname, port } = new URL(origin);
  try {
    const socket = connect({ hostname, port: Number(port) || 80 });
    await socket.opened;
    await socket.close();
    return true;
  } catch {
    return false;
  }
}

const IDEMPOTENT = ["GET", "HEAD", "OPTIONS"];

/**
 * The shard's answer to the request, sent as it came, held for up to
 * RETRY_MS while the shard restarts, as Caddy holds requests for the router.
 * workerd's fetch says only "Network connection lost." whether the shard
 * refused the connection or dropped it with the request half done, so:
 * a GET (a read, or a live connection's upgrade) is sent again on any
 * failure; anything else is sent once the shard accepts a connection, and
 * never again, so a mutation the shard may have run is never run twice.
 * Bodies stream through as they arrive (a dump being restored, too); only
 * the fan-out below reads one first, to send it to every shard.
 */
async function send(
  request: Request,
  origin: string,
  path: string,
  body: BodyInit | null = request.body,
): Promise<Response> {
  const idempotent = IDEMPOTENT.includes(request.method);
  const started = Date.now();
  if (!idempotent)
    while (!(await listening(origin))) {
      if (Date.now() - started >= RETRY_MS)
        throw new Error(`${origin} refused connections for ${RETRY_MS} ms.`);
      await pause(RETRY_INTERVAL_MS);
    }
  for (;;) {
    try {
      return await fetch(`${origin}${path}`, {
        method: request.method,
        headers: request.headers,
        body,
        redirect: "manual",
      });
    } catch (error) {
      if (!idempotent || Date.now() - started >= RETRY_MS) throw error;
      await pause(RETRY_INTERVAL_MS);
    }
  }
}

const unavailable = (shard: number) =>
  new Response(`Shard ${shard} did not answer.`, { status: 502 });

/** Every shard's /healthz/deep: ok only when each says so. */
async function deep(shards: Shards): Promise<Response> {
  const failures = (
    await Promise.all(
      shards.origins.map(async (origin, shard) => {
        try {
          const response = await fetch(`${origin}/healthz/deep`, {
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
          });
          const text = await response.text();
          return response.ok && text === "ok"
            ? null
            : `shard ${shard}: ${response.status} ${text.slice(0, 100)}`;
        } catch (error) {
          return `shard ${shard}: no answer (${String(error).slice(0, 100)})`;
        }
      }),
    )
  ).filter((failure) => failure !== null);
  return failures.length
    ? new Response(`unhealthy\n${failures.join("\n")}\n`, { status: 503 })
    : new Response("ok");
}

/**
 * The sites with unnotified pauses, from every shard. A shard's refusal (no
 * secret, wrong method) is the answer; a shard that does not answer is left
 * out, and its sites' alerts wait for the next run.
 */
async function unnotified(request: Request, shards: Shards, path: string) {
  const body = request.body ? await request.arrayBuffer() : null;
  const answers = await Promise.all(
    shards.origins.map(async (origin) => {
      try {
        return await send(request, origin, path, body);
      } catch {
        return null;
      }
    }),
  );
  const refusal = answers.find(
    (answer) => answer && answer.status >= 400 && answer.status < 500,
  );
  if (refusal) return refusal;
  const values: { sites: string[] }[] = [];
  for (const answer of answers) {
    if (answer?.status !== 200) continue;
    const parsed = (await answer.json().catch(() => null)) as {
      value?: { sites?: unknown };
    } | null;
    if (Array.isArray(parsed?.value?.sites))
      values.push({ sites: parsed.value.sites as string[] });
  }
  if (!values.length) return unavailable(0);
  return Response.json({ value: mergeUnnotified(values) });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return new Response("ok");
    const shards = shardsOf(env);
    if (url.pathname === "/healthz/deep") return deep(shards);
    if (!SERVED.test(url.pathname))
      return new Response("Not found.", { status: 404 });
    if (url.pathname.startsWith("/sdk/")) return serveSdk(request, env);
    // Both are each shard's memory, merged the same way.
    if (
      url.pathname === "/v1/breakers/unnotified" ||
      url.pathname === "/v1/notifications/pending"
    )
      return unnotified(request, shards, url.pathname + url.search);
    const site = siteOfPath(url.pathname);
    const shard =
      site === null
        ? 0
        : shardOf(site, shards.origins.length, shards.overrides);
    try {
      return await send(
        request,
        shards.origins[shard],
        url.pathname + url.search,
      );
    } catch (error) {
      console.error(`Shard ${shard} did not answer`, error);
      return unavailable(shard);
    }
  },
} satisfies ExportedHandler<RouterEnv>;
