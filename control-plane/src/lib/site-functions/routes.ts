import { DataError } from "../site-data/validation";

// Routes (1.1.0): a site's opt-in server-rendered pages. `_naru/routes.json`
// says which paths run the site's code, in Cloudflare Pages' `_routes.json`
// form, and `_naru/routes.js`'s default export answers each of them, run as
// a visitor's query in the site's object:
//
//   { "version": 1, "include": ["/", "/posts/*"], "exclude": ["/posts/feed"] }
//
// `*` takes anything, slashes too; an excluded path is never routed, whatever
// includes it. Every other path is the site's static files, as before. The
// edge Worker decides (pages.ts), naru-dev too, from the rules alone, without
// running the site's code, and both shape what the route answered.

/** Which paths run `_naru/routes.js`: `_routes.json`'s include and exclude. */
export type RouteRules = { include: string[]; exclude: string[] };

/** A site without `_naru/routes.json`: every path is a file. */
export const NO_ROUTES: RouteRules = Object.freeze({
  include: [],
  exclude: [],
}) as RouteRules;

/** Cloudflare's limits: 100 rules in all, each of 100 characters at most. */
const MAX_RULES = 100;
const MAX_RULE_LENGTH = 100;

const refused = (message: string) =>
  new DataError(400, `_naru/routes.json: ${message}`);

/**
 * `_naru/routes.json`, checked: version 1, at least one include rule,
 * at most 100 rules of at most 100 characters, each a path from "/".
 */
export function routeRules(text: string): RouteRules {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw refused("not JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw refused('an object of "version", "include" and "exclude".');
  const {
    version,
    include,
    exclude = [],
    ...rest
  } = value as Record<string, unknown>;
  if (Object.keys(rest).length)
    throw refused(
      `unknown ${Object.keys(rest)
        .map((key) => `"${key}"`)
        .join(", ")}.`,
    );
  if (version !== 1) throw refused('"version" is 1.');
  const rules = (list: unknown, name: string) => {
    if (!Array.isArray(list)) throw refused(`"${name}" is a list of paths.`);
    for (const rule of list)
      if (
        typeof rule !== "string" ||
        !rule.startsWith("/") ||
        rule.length > MAX_RULE_LENGTH
      )
        throw refused(
          `${JSON.stringify(rule)} in "${name}" is not a path from / of at most ${MAX_RULE_LENGTH} characters.`,
        );
    return list as string[];
  };
  const routes = {
    include: rules(include, "include"),
    exclude: rules(exclude, "exclude"),
  };
  if (!routes.include.length) throw refused('"include" needs a path.');
  if (routes.include.length + routes.exclude.length > MAX_RULES)
    throw refused(`at most ${MAX_RULES} rules.`);
  return routes;
}

/** Whether `rule` takes `pathname`: `*` is anything, slashes too. */
function takes(rule: string, pathname: string) {
  const parts = rule.split("*");
  if (parts.length === 1) return rule === pathname;
  if (!pathname.startsWith(parts[0]) || !pathname.endsWith(parts.at(-1)!))
    return false;
  let at = parts[0].length;
  const end = pathname.length - parts.at(-1)!.length;
  if (end < at) return false;
  for (const part of parts.slice(1, -1)) {
    const found = pathname.indexOf(part, at);
    if (found < 0 || found + part.length > end) return false;
    at = found + part.length;
  }
  return true;
}

/** Whether the site's code answers `pathname`: included, and not excluded. */
export function routed(rules: RouteRules, pathname: string) {
  return (
    !rules.exclude.some((rule) => takes(rule, pathname)) &&
    rules.include.some((rule) => takes(rule, pathname))
  );
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
