import { DataError } from "../site-data/validation";

// Routes (1.1.0): a site's opt-in server-rendered pages. Each file in
// _naru/routes/ answers the path it is named for, through its default
// export, run as a visitor's query in the site's object:
//
//   routes/index.js        /
//   routes/about.js        /about
//   routes/posts/index.js  /posts and /posts/
//   routes/posts/_id.js    /posts/<id>, as params.id
//   routes/docs/_...path.js  /docs, /docs/a, /docs/a/b, as params.path
//                            ([], ["a"], ["a", "b"])
//
// A segment that starts with _ takes any one path segment; one that starts
// with _... takes the rest of the path, none or more segments, and is only
// the last segment, never the first (so the site's files stay reachable).
// A fixed segment wins over _name, and _name over _...name. Paths that match
// no route are the site's static files, as before. The edge Worker matches
// paths (pages.ts), naru-dev too, and both shape what a route answered.

/** The route a release file names: routes/posts/_id.js is "posts/_id". */
export function routeOf(filename: string) {
  return filename.replace(/^routes\//, "").replace(/\.m?js$/, "");
}

/** Whether a route's segment takes the rest of the path (`_...name`). */
const isRest = (part: string) => /^_\.\.\.[A-Za-z0-9_]+$/.test(part);

/**
 * Whether `route` names a route: segments of letters, digits, _, - and
 * dots (feed.xml.js answers /feed.xml), never "." or "..", with a rest
 * segment (`_...name`) only last and never first.
 */
export const validRoute = (route: string) => {
  const parts = route.split("/");
  return parts.every(
    (part, index) =>
      /^[A-Za-z0-9_.-]{1,64}$/.test(part) &&
      part !== "." &&
      part !== ".." &&
      (!part.startsWith("_...") ||
        (isRest(part) && index > 0 && index === parts.length - 1)),
  );
};

/** A route's parameters: one segment each, or a rest segment's list. */
export type RouteParams = Record<string, string | string[]>;

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

/**
 * The route matching `pathname`: at each segment, from the first, a fixed
 * segment wins over a parameter, and a parameter over a rest segment.
 */
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
  // only the index. A rest segment takes the path's own segments alone.
  const candidates = pathname.endsWith("/")
    ? [[...segments, "index"]]
    : [segments, [...segments, "index"]];
  let best: { route: string; params: RouteParams; score: string } | null = null;
  for (const route of routes) {
    const rest = isRest(route.split("/").at(-1) ?? "");
    for (const wanted of rest ? [segments] : candidates) {
      const found = matchOne(route, wanted);
      if (found && (!best || found.score > best.score))
        best = { route, ...found };
    }
  }
  return best && { route: best.route, params: best.params };
}

/**
 * How `route` matches the segments `wanted`: its parameters, and a score
 * (2 a fixed segment, 1 a parameter, 0 the rest) that orders matches.
 */
function matchOne(route: string, wanted: string[]) {
  const pattern = route.split("/");
  const rest = isRest(pattern.at(-1) ?? "");
  const fixed = rest ? pattern.slice(0, -1) : pattern;
  if (rest ? wanted.length < fixed.length : fixed.length !== wanted.length)
    return null;
  const params: RouteParams = {};
  let score = "";
  for (const [index, part] of fixed.entries()) {
    if (part === wanted[index]) score += "2";
    else if (
      part.startsWith("_") &&
      part.length > 1 &&
      wanted[index] !== "index"
    ) {
      params[part.slice(1)] = wanted[index];
      score += "1";
    } else return null;
  }
  if (rest) {
    params[pattern.at(-1)!.slice(4)] = wanted.slice(fixed.length);
    score += "0";
  }
  return { params, score };
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
