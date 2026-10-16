import { DataError } from "../site-data/validation";

// Routes (1.1.0): a site's opt-in server-rendered pages. Each file in
// _naru/routes/ answers the path it is named for, through its default
// export, run as a visitor's query in the site's object:
//
//   routes/index.js        /
//   routes/about.js        /about
//   routes/posts/index.js  /posts and /posts/
//   routes/posts/_id.js    /posts/<id>, as params.id
//
// A segment that starts with _ takes any one path segment. Paths that match
// no route are the site's static files, as before. The edge Worker matches
// paths (pages.ts), naru-dev too, and both shape what a route answered.

/** The route a release file names: routes/posts/_id.js is "posts/_id". */
export function routeOf(filename: string) {
  return filename.replace(/^routes\//, "").replace(/\.m?js$/, "");
}

/**
 * Whether `route` names a route: segments of letters, digits, _, - and
 * dots (feed.xml.js answers /feed.xml), never "." or "..".
 */
export const validRoute = (route: string) =>
  route
    .split("/")
    .every(
      (part) =>
        /^[A-Za-z0-9_.-]{1,64}$/.test(part) && part !== "." && part !== "..",
    );

/** `route`, checked, as the site's object is asked to render it. */
export function routeModule(value: unknown): string {
  if (typeof value !== "string" || !validRoute(value))
    throw new DataError(400, "Invalid route.");
  return value;
}

/**
 * What `{ body, type }` may be served as: text the browser shows or a
 * reader parses, never anything that runs as the site (HTML is `html`).
 */
const BODY_TYPES = [
  "text/plain",
  "text/css",
  "text/calendar",
  "text/xml",
  "application/xml",
  "application/rss+xml",
  "application/atom+xml",
  "application/json",
];

/** The route matching `pathname`, preferring fixed segments to parameters. */
export function matchRoute(routes: readonly string[], pathname: string) {
  let segments: string[];
  try {
    segments = pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
  // "/posts" may be routes/posts.js or routes/posts/index.js; "/posts/"
  // only the index.
  const candidates = pathname.endsWith("/")
    ? [[...segments, "index"]]
    : [segments, [...segments, "index"]];
  let best: {
    route: string;
    params: Record<string, string>;
    score: string;
  } | null = null;
  for (const wanted of candidates)
    for (const route of routes) {
      const pattern = route.split("/");
      if (pattern.length !== wanted.length) continue;
      const params: Record<string, string> = {};
      let score = "";
      const matches = pattern.every((part, index) => {
        if (part === wanted[index]) {
          score += "1";
          return true;
        }
        if (
          part.startsWith("_") &&
          part.length > 1 &&
          wanted[index] !== "index"
        ) {
          params[part.slice(1)] = wanted[index];
          score += "0";
          return true;
        }
        return false;
      });
      if (matches && (!best || score > best.score))
        best = { route, params, score };
    }
  return best && { route: best.route, params: best.params };
}

/** What a route answered, as the page is served. */
export type RouteAnswer = {
  status: number;
  /** Seconds the edge may keep the page, 0–300. */
  cache: number;
} & (
  | { html: string }
  | { body: string; type: string }
  | { file: string; head: string }
  | { redirect: string }
);

const invalid = (message: string) =>
  new DataError(500, `The route answered ${message}`);

/**
 * A route's answer, checked: a string of HTML, or `{ html }`, `{ body, type }`
 * (text such as a feed, served as `type`), `{ file, head }` (a site file
 * with `head` added to its <head>, for link previews of a page the browser
 * renders) or `{ redirect }`, each with an optional `status` and `cache`
 * (seconds).
 */
export function routeAnswer(value: unknown): RouteAnswer {
  if (typeof value === "string") return { status: 200, cache: 0, html: value };
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid(
      "neither HTML nor { html }, { body }, { file } or { redirect }.",
    );
  const answer = value as Record<string, unknown>;
  const status = answer.status ?? (answer.redirect !== undefined ? 302 : 200);
  if (
    !Number.isInteger(status) ||
    (status as number) < 200 ||
    (status as number) > 599
  )
    throw invalid("a status outside 200–599.");
  const cache = answer.cache ?? 0;
  if (
    !Number.isInteger(cache) ||
    (cache as number) < 0 ||
    (cache as number) > 300
  )
    throw invalid("a cache other than 0–300 seconds.");
  const base = { status: status as number, cache: cache as number };
  if (typeof answer.html === "string") return { ...base, html: answer.html };
  if (typeof answer.body === "string") {
    if (typeof answer.type !== "string" || !BODY_TYPES.includes(answer.type))
      throw invalid(
        `a body whose type is not one of ${BODY_TYPES.join(", ")}.`,
      );
    return { ...base, body: answer.body, type: answer.type };
  }
  if (typeof answer.file === "string") {
    const file = answer.file.replace(/^\/+/, "");
    if (!file || file.split("/").some((part) => part === ".." || part === "."))
      throw invalid("a file outside the site.");
    if (answer.head !== undefined && typeof answer.head !== "string")
      throw invalid("a head that is not a string.");
    return { ...base, file, head: (answer.head as string | undefined) ?? "" };
  }
  if (typeof answer.redirect === "string") {
    if (![301, 302, 303, 307, 308].includes(base.status))
      throw invalid("a redirect without a redirect status.");
    if (!/^(\/(?!\/)|https:\/\/)/.test(answer.redirect))
      throw invalid("a redirect to neither a path nor an https URL.");
    return { ...base, redirect: answer.redirect };
  }
  throw invalid(
    "neither HTML nor { html }, { body }, { file } or { redirect }.",
  );
}

/** `head` added to an HTML file's <head>, or before it when it has none. */
export function withHead(html: string, head: string) {
  if (!head) return html;
  const at = html.search(/<\/head\s*>/i);
  return at < 0 ? head + html : html.slice(0, at) + head + html.slice(at);
}
