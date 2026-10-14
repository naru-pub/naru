import { decodePath, resolvePath } from "./pages";

// Versioned asset URLs, for the sites in VERSIONED_ASSET_SITES ("*" for all).
// Browsers cannot be told to forget a file, so instead a page names each of
// its files by version: as an HTML page streams out, its own references to
// the site's files gain `?v=<fingerprint>`, the start of the file's ETag,
// which changes with its contents. A request carrying the file's current
// version may be kept by the browser for a year (the edge for HTML, JS and
// JSON; the zone's cache rule for r2.naru.pub), and an edit, which changes
// the fingerprint, reaches visitors with the next page they load.
//
// Files the edge does not serve itself are named at the bucket's public
// domain directly, sparing the redirect. Only references a page makes in its
// own markup are versioned, and only those to a file that exists, with no
// query of their own: classic scripts (a module's imports would load a second
// copy under the other URL), stylesheets and icons, images, and media, and
// the preloads of files the page uses in those.
// Everything else keeps the unversioned URL and its usual caching.

export interface AssetEnv {
  PLATFORM_DOMAIN: string;
  R2_PUBLIC_DOMAIN: string;
  /** Comma-separated logins whose pages are rewritten, or "*" for every site. */
  VERSIONED_ASSET_SITES?: string;
}

/** How long a browser keeps a file requested at its current version. */
export const VERSIONED_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** Looks up a bucket object's ETag, or null when it does not exist. */
export type EtagLookup = (key: string) => Promise<string | null>;

export function versionsAssets(env: AssetEnv, login: string) {
  const sites = (env.VERSIONED_ASSET_SITES ?? "")
    .split(",")
    .map((site) => site.trim());
  return sites.includes("*") || sites.includes(login);
}

/** The version a file is named by: the start of its ETag. */
export function fingerprint(etag: string) {
  return etag.replace(/^W\//, "").replaceAll('"', "").slice(0, 12);
}

/**
 * The versioned URL for a reference `ref` a page at `base` makes, or null to
 * leave it as written. `served` are the extensions the edge serves itself.
 */
export async function versionedUrl(
  ref: string,
  base: URL,
  login: string,
  env: AssetEnv,
  served: string[],
  etagOf: EtagLookup,
): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(ref.trim(), base);
  } catch {
    return null;
  }
  if (url.origin !== base.origin || url.search) return null;
  const path = decodePath(url.pathname.replace(/^\/+/, ""));
  // A directory, or a path that is not UTF-8, names no single file.
  if (!path || resolvePath(path) !== path) return null;
  const etag = await etagOf(`${login}/${path}`);
  if (!etag) return null;
  const version = `?v=${fingerprint(etag)}${url.hash}`;
  const extension = path.split(".").at(-1)!.toLowerCase();
  if (served.includes(extension)) return `${url.pathname}${version}`;
  // Encoded as the control plane purges it (control-plane/src/lib/cache-purge.ts).
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `https://${env.R2_PUBLIC_DOMAIN}/${login}/${encoded}${version}`;
}

/** `srcset` with each candidate's URL versioned where it can be. */
export async function versionedSrcset(
  srcset: string,
  version: (ref: string) => Promise<string | null>,
) {
  const candidates = await Promise.all(
    srcset.split(",").map(async (candidate) => {
      const [ref, ...descriptor] = candidate.trim().split(/\s+/);
      if (!ref) return candidate.trim();
      const url = (await version(ref)) ?? ref;
      return [url, ...descriptor].join(" ");
    }),
  );
  return candidates.join(", ");
}

const CLASSIC_SCRIPT_TYPES = [
  "",
  "text/javascript",
  "application/javascript",
  "text/ecmascript",
  "application/ecmascript",
];
const LINK_RELS = ["stylesheet", "icon", "apple-touch-icon"];

type ReferenceHandler = (ref: string, base: URL) => Promise<string | null>;

/**
 * A rewriter calling `onReference` for each reference that may be versioned,
 * replacing it with what that returns, and versioning a preload when
 * `preloads` says the page uses its file where it is versioned.
 */
function referenceRewriter(
  pageUrl: URL,
  onReference: ReferenceHandler,
  preloads: (href: string) => boolean,
) {
  let base = pageUrl;
  const attribute = (name: string) => ({
    async element(element: Element) {
      const value = element.getAttribute(name);
      if (value === null) return;
      const versioned =
        name === "srcset"
          ? await versionedSrcset(value, (ref) => onReference(ref, base))
          : await onReference(value, base);
      if (versioned && versioned !== value)
        element.setAttribute(name, versioned);
    },
  });
  const resolved = (ref: string) => {
    try {
      return new URL(ref.trim(), base).href;
    } catch {
      return null;
    }
  };

  return new HTMLRewriter()
    .on("base[href]", {
      element(element) {
        try {
          base = new URL(element.getAttribute("href")!, pageUrl);
        } catch {
          // An unparseable base leaves references resolved against the page.
        }
      },
    })
    .on("script[src]", {
      async element(element) {
        const type = (element.getAttribute("type") ?? "").trim().toLowerCase();
        if (CLASSIC_SCRIPT_TYPES.includes(type))
          await attribute("src").element(element);
      },
    })
    .on("link[href][rel]", {
      async element(element) {
        const rels = element.getAttribute("rel")!.toLowerCase().split(/\s+/);
        if (rels.some((rel) => LINK_RELS.includes(rel)))
          await attribute("href").element(element);
        else if (rels.includes("preload")) {
          const href = resolved(element.getAttribute("href")!);
          if (href && preloads(href)) await attribute("href").element(element);
        }
      },
    })
    .on("img[src], source[src], video[src], audio[src]", attribute("src"))
    .on("img[srcset], source[srcset]", attribute("srcset"))
    .on("video[poster]", attribute("poster"));
}

/** Distinct files a page may have looked up; past it, references stay plain. */
export const MAX_LOOKUPS = 200;

/**
 * The page's response with its references to the site's files versioned. A
 * preload is versioned only when the page uses its file where it is
 * versioned too, or the two would download it twice; so the page is read
 * whole first, to find those uses, and to start looking up every file it
 * names at once rather than one by one as it streams. A page that is not
 * UTF-8, which the rewriter would misread, is sent as it is, as are the
 * references past MAX_LOOKUPS distinct files, which would otherwise run the
 * Worker past its subrequests.
 */
export async function versionAssets(
  response: Response,
  pageUrl: URL,
  login: string,
  env: AssetEnv,
  served: string[],
  etagOf: EtagLookup,
) {
  const bytes = await response.arrayBuffer();
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return new Response(bytes, response);
  }

  // Each file is looked up once per page, however often the page names it.
  const lookups = new Map<string, Promise<string | null>>();
  const cachedEtag: EtagLookup = (key) => {
    if (!lookups.has(key)) {
      if (lookups.size >= MAX_LOOKUPS) return Promise.resolve(null);
      lookups.set(
        key,
        etagOf(key).catch(() => null),
      );
    }
    return lookups.get(key)!;
  };
  const versions = new Map<string, Promise<string | null>>();
  const version = (ref: string, base: URL) => {
    const key = `${base.href} ${ref}`;
    if (!versions.has(key))
      versions.set(
        key,
        versionedUrl(ref, base, login, env, served, cachedEtag),
      );
    return versions.get(key)!;
  };

  const used = new Set<string>();
  await referenceRewriter(
    pageUrl,
    async (ref, base) => {
      try {
        used.add(new URL(ref.trim(), base).href);
      } catch {
        // Not a URL: nothing to version.
      }
      // Started, not awaited: the second pass finds it done or under way.
      void version(ref, base);
      return null;
    },
    () => false,
  )
    .transform(new Response(bytes))
    .arrayBuffer();

  return referenceRewriter(pageUrl, version, (href) =>
    used.has(href),
  ).transform(new Response(bytes, response));
}
