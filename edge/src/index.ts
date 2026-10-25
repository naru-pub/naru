import {
  domainSite,
  siteDomain,
  siteSuspended,
  invalidTable,
  storeDomains,
  type DomainsEnv,
  type DomainTable,
} from "./domains";
import {
  notFound,
  suspended,
  servePage,
  siteOf,
  type PagesEnv,
  type RenderRoute,
} from "./pages";
import type { PageviewLog } from "./pageview-log";
import type { SiteData } from "./site";
import { Standby, type StandbyEnv } from "./standby";
import type { Outcome } from "./types";
import { DUMP_CONTENT_TYPE } from "../../control-plane/src/lib/site-data/dump-format";
import type { DataError } from "../../control-plane/src/lib/site-data/validation";
import { interruptedCall } from "./sql";
import { notifyPending } from "./notify";
import {
  admit,
  breakers,
  settle,
  type CallIdentity,
  type Paused,
} from "./breaker";

export { PageviewLog } from "./pageview-log";
// No SiteData here: site databases live on the mini (seoul.ts exports it
// there), and local runs export it from local.ts.
export { Standby } from "./standby";

export interface Env extends PagesEnv, DomainsEnv, StandbyEnv {
  /**
   * On Cloudflare: what reaches the mini, and its health check (standby.ts).
   * Absent under workerd on the mini and in local runs.
   */
  STANDBY?: DurableObjectNamespace<Standby>;
  PAGEVIEWS: DurableObjectNamespace<PageviewLog>;
  /**
   * Site databases: on the mini (seoul.ts) and in local runs (local.ts).
   * Not bound on Cloudflare, where /v1/sites is not found.
   */
  SITES: DurableObjectNamespace<SiteData>;
  /** Shared with the control plane, the only caller of /v1/sites. */
  EDGE_WORKER_SECRET: string;
  /**
   * The mini's own /v1/sites secret (its EDGE_WORKER_SECRET), for rendering
   * a site's routes there. Without it, routes are served as files.
   */
  SDK_ORIGIN_SECRET?: string;
  /** The default monthly budget of anonymous requests per site. */
  SITE_MONTHLY_REQUESTS?: string;
  /**
   * The runtime's step budget for one SQLite statement, in ms: on the mini,
   * from the environment that sets it in workerd (seoul/workerd/).
   */
  SQLITE_STATEMENT_TIMEOUT_MS?: string;
  /**
   * "1" opens TEST_OPERATIONS. Only the test harness sets it
   * (control-plane/scripts/with-edge-worker.sh); production never does.
   */
  TEST_OPERATIONS?: string;
}

// Two surfaces. <login>.naru.pub, or a custom domain, is a hosted site
// (pages.ts, domains.ts). The Data SDK (sdk.ts) and the public data API
// (website.ts) are sdk.naru.pub's, answered beside the site databases on the
// mini (seoul.ts) and in local runs (local.ts), never here; on a platform
// host every other path is the control plane's: /v1/sites/<site>/<operation>,
// /v1/pageviews/<operation> and /v1/domains/replace are the control plane's
// own: POST with a JSON body, answered with `{ value }` or
// `{ error: { status, message, code } }` at that status. A site's object is
// named by the site, so every request for a site meets the same one. Dumps
// (DUMP_OPERATIONS) are NDJSON instead (dump-format.ts), streamed both ways:
// `dump` answers one as its body, and `restore` takes one as its own; their
// refusals are JSON as above.
const OPERATIONS = [
  "execute",
  "batch",
  "collections",
  "createCollections",
  "configureCollections",
  "mediaReferences",
  // Where the site's own tables name uploads, scanned when the owner's
  // media library asks (1.1.0).
  "tableMediaReferences",
  "siteTables",
  // A page of one of the site's tables, for the owner's control panel.
  "tableRows",
  // One read-only statement of the owner's own SQL, from the same tab.
  "ownerQuery",
  "rolesOfMembers",
  "setMemberRoles",
  // Uploads as Naru Media finishes and deletes them, for site SQL's _naru_uploads.
  "recordMedia",
  "forgetMedia",
  "render",
  "erase",
  "configure",
  "call",
  "activateFunctions",
  // The tables a template version's migrations make, run on an object no
  // site uses and rolled back (control-plane board/site-code.ts).
  "trialMigrations",
  // Returning a site to a restore point its object kept in R2 (1.1.0), and
  // keeping one when the owner asks.
  "restoreFrom",
  "saveRestorePoint",
  "disconnect",
  // A site's whole database, as NDJSON (control-plane lib/edge/dumps.ts).
  "dump",
  "restore",
  // The site's paused statements (breaker.ts): its latest pauses, the
  // operators told of them, and the owner letting one run again.
  "breakerTrips",
  "ackBreakerTrips",
  "clearBreaker",
  // ctx.notify's queue (notify.ts), for the control plane's app-notifications job.
  "notifyOutbox",
  "ackNotifyOutbox",
] as const;
// Read and replace a whole site, ids and times included: for tests to plant
// and inspect what the public operations cannot. Not found in production.
const TEST_OPERATIONS = [
  "export",
  "import",
  "putFunctions",
  // What dumps and restores leave of their own tables, and a restore point
  // planted in R2 as an older release wrote it.
  "internalTables",
  "putRestorePoint",
] as const;
type Operation = (typeof OPERATIONS)[number] | (typeof TEST_OPERATIONS)[number];
/** The operations whose request body is a dump, read as it arrives. */
const DUMP_OPERATIONS: readonly string[] = ["restore"];

// Site names.
const SITE = /^[a-zA-Z0-9_-]{1,64}$/;

// A stub's methods are remote calls, so each is named rather than looked up.
function dispatch(
  stub: DurableObjectStub<SiteData>,
  operation: Operation,
  input: never,
) {
  switch (operation) {
    case "execute":
      return stub.execute(input);
    case "batch":
      return stub.batch(input);
    case "collections":
      return stub.collections(input);
    case "createCollections":
      return stub.createCollections(input);
    case "configureCollections":
      return stub.configureCollections(input);
    case "mediaReferences":
      return stub.mediaReferences(input);
    case "tableMediaReferences":
      return stub.tableMediaReferences(input);
    case "siteTables":
      return stub.siteTables();
    case "trialMigrations":
      return stub.trialMigrations(input);
    case "tableRows":
      return stub.tableRows(input);
    case "ownerQuery":
      return stub.ownerQuery(input);
    case "rolesOfMembers":
      return stub.rolesOfMembers(input);
    case "render":
      return stub.render(input);
    case "setMemberRoles":
      return stub.setMemberRoles(input);
    case "recordMedia":
      return stub.recordMedia(input);
    case "forgetMedia":
      return stub.forgetMedia(input);
    case "export":
      return stub.export();
    case "import":
      return stub.import(input);
    case "erase":
      return stub.erase();
    case "configure":
      return stub.configure(input);
    case "call":
      return stub.call(input);
    case "activateFunctions":
      return stub.activateFunctions(input);
    case "disconnect":
      return stub.disconnect(input);
    case "restoreFrom":
      return stub.restoreFrom(input);
    case "saveRestorePoint":
      return stub.saveRestorePoint(input);
    case "dump":
      return stub.dump();
    case "internalTables":
      return stub.internalTables(input);
    case "putRestorePoint":
      return stub.putRestorePoint(input);
    case "restore":
      return stub.restore(input);
    case "putFunctions":
      return stub.putFunctions(input);
    case "breakerTrips":
      return stub.breakerTrips(input);
    case "ackBreakerTrips":
      return stub.ackBreakerTrips(input);
    case "notifyOutbox":
      return stub.notifyOutbox(input);
    case "ackNotifyOutbox":
      return stub.ackNotifyOutbox(input);
    case "clearBreaker":
      return stub.clearBreakerTrips(input);
  }
}

/** The site's function a call or a render runs, as breakers name it. */
function callOf(operation: string, input: unknown): CallIdentity | null {
  const given = input as {
    kind?: unknown;
    file?: unknown;
    name?: unknown;
  } | null;
  if (
    operation === "call" &&
    typeof given?.file === "string" &&
    typeof given.name === "string" &&
    (given.kind === "query" ||
      given.kind === "mutation" ||
      given.kind === "route")
  )
    return { kind: given.kind, file: given.file, name: given.name };
  if (operation === "render")
    return { kind: "route", file: "routes", name: "default" };
  return null;
}

function failure(
  status: number,
  message: string,
  error?: Pick<DataError, "code" | "details">,
) {
  return Response.json(
    {
      error: {
        status,
        message,
        ...(error?.code ? { code: error.code } : {}),
        ...(error?.details === undefined ? {} : { details: error.details }),
      },
    },
    { status },
  );
}

async function authorized(request: Request, secret: string | undefined) {
  if (!secret) return false;
  const given = new TextEncoder().encode(
    request.headers.get("authorization") ?? "",
  );
  const expected = new TextEncoder().encode(`Bearer ${secret}`);
  return (
    given.byteLength === expected.byteLength &&
    crypto.subtle.timingSafeEqual(given, expected)
  );
}

/** The one log of every edge-served site's pageviews (pageview-log.ts). */
const pageviews = (env: Env) =>
  env.PAGEVIEWS.get(env.PAGEVIEWS.idFromName("pageviews"));

/**
 * A request for a subdomain or a custom domain: the site it names, or the one
 * the control plane listed the domain for. Any other host is not found.
 */
async function hostedSite(request: Request, env: Env, ctx: ExecutionContext) {
  const url = new URL(request.url);
  const subdomain = url.hostname.endsWith(`.${env.PLATFORM_DOMAIN}`);
  const login = subdomain
    ? siteOf(url.hostname, env)
    : await domainSite(url.hostname, env);
  if (!login) return notFound();
  if (await siteSuspended(login, env)) return suspended();
  // Which site this host serves, for the control plane to see that a custom
  // domain reaches Naru however its DNS gets here (domain-dns.ts there).
  if (url.pathname === SITE_PROBE_PATH)
    return new Response(login, {
      headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
    });
  if (subdomain) {
    const redirect = await domainRedirect(request, url, login, env);
    if (redirect) return redirect;
  }
  return servePage(
    request,
    env,
    login,
    ctx,
    (event) =>
      ctx.waitUntil(
        pageviews(env)
          .record(event)
          .catch((error) =>
            // Analytics is best effort: a page is never refused over it.
            console.error(`Recording a pageview for ${login} failed`, error),
          ),
      ),
    (input) => renderRoute(env, input),
  );
}

/** Answered on every hosted host with the site it serves. */
export const SITE_PROBE_PATH = "/.well-known/naru-site";

/**
 * A site served on a custom domain moves its subdomain's pages there, so
 * links and search results settle on the one address. Only reads move: a
 * form posted to the subdomain is answered where it was sent. Browsers keep
 * the redirect a day, not forever, so a domain that later lapses or is
 * removed sends no one to it for long.
 */
async function domainRedirect(
  request: Request,
  url: URL,
  login: string,
  env: Env,
) {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const domain = await siteDomain(login, env);
  if (!domain) return null;
  return new Response(null, {
    status: 301,
    headers: {
      Location: `https://${domain}${url.pathname}${url.search}`,
      "Cache-Control": "max-age=86400",
    },
  });
}

/**
 * A route's page from the site's object, on the mini, reached through the
 * Standby object (standby.ts). While the mini is away this fails, and
 * pages.ts answers with the site's index.html. A Worker with no Standby
 * (local runs) holds the objects itself.
 */
async function renderRoute(
  env: Env,
  input: Parameters<RenderRoute>[0],
): ReturnType<RenderRoute> {
  const standby = standbyObject(env);
  if (!standby)
    return env.SITES.get(env.SITES.idFromName(input.site)).render(input);
  if (!env.SDK_ORIGIN_SECRET)
    return {
      ok: false,
      error: { status: 503, message: "Routes are not set up here." },
    };
  const response = await standby.forward(
    new Request(
      `https://sdk.${env.PLATFORM_DOMAIN}/v1/sites/${encodeURIComponent(input.site)}/render`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.SDK_ORIGIN_SECRET}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      },
    ),
  );
  const body = (await response.json().catch(() => null)) as {
    value?: { result: unknown };
    error?: {
      status: number;
      message: string;
      details?: unknown;
      retryAfter?: number;
    };
  } | null;
  if (response.ok && body?.value) return { ok: true, value: body.value };
  // The site's object's own refusal (a lapsed site's is a 404 with its
  // reason, pages.ts) comes at its status; anything else, such as Caddy's
  // 502 while workerd is down, is the mini being away.
  return {
    ok: false,
    error:
      body?.error && body.error.status === response.status
        ? body.error
        : { status: 503, message: "The site did not answer." },
  };
}

async function pageviewOperation(
  request: Request,
  env: Env,
  operation: string,
) {
  if (request.method !== "POST") return failure(405, "Method not allowed.");
  let input: Record<string, unknown>;
  try {
    input = await request.json();
  } catch {
    return failure(400, "Expected a JSON body.");
  }
  const log = pageviews(env);
  if (operation === "drain")
    return Response.json({ value: await log.drain(input) });
  if (operation === "ack" && Number.isSafeInteger(input.through))
    return Response.json({
      value: await log.ack({ through: input.through as number }),
    });
  return failure(404, "Not found.");
}

async function replaceDomains(request: Request, env: Env) {
  if (request.method !== "POST") return failure(405, "Method not allowed.");
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return failure(400, "Expected a JSON body.");
  }
  const invalid = invalidTable(input);
  if (invalid) return failure(400, invalid);
  await storeDomains(env, input as DomainTable);
  return Response.json({ value: null });
}

/**
 * Hosts that are not a hosted site: the platform domain, the SDK's own host
 * where this runs on the mini (seoul.ts), this Worker's custom domain, and
 * the address `wrangler dev` answers on.
 */
export function platformHost(hostname: string, env: Env) {
  return (
    hostname === env.PLATFORM_DOMAIN ||
    hostname === `sdk.${env.PLATFORM_DOMAIN}` ||
    hostname === `edge.${env.PLATFORM_DOMAIN}` ||
    hostname === "localhost" ||
    /^[\d.]+$|^\[/.test(hostname)
  );
}

/** The one Standby object, where it exists (Cloudflare). */
const standbyObject = (env: Env) =>
  env.STANDBY?.get(env.STANDBY.idFromName("standby"));

export default {
  async fetch(request: Request, env: Env, ctx): Promise<Response> {
    const { hostname, pathname } = new URL(request.url);
    // The zone's routes send every hosted site here: *.naru.pub, and */* for
    // custom domains. Routes without a Worker keep the platform domain on the
    // control plane and the bucket's public domains on R2; this Worker's own
    // custom domain takes precedence over all of them (docs/deployment.md).
    // sdk.naru.pub is DNS-only, straight to the mini, so it never comes here
    // on Cloudflare; under workerd on the mini, seoul.ts sends it what is
    // not the SDK or the data API. A hosted site's own /sdk/ and
    // /api/data/v1/ paths are its files, like any other.
    if (!platformHost(hostname, env)) return hostedSite(request, env, ctx);
    if (!(await authorized(request, env.EDGE_WORKER_SECRET)))
      return failure(401, "Unauthorized.");
    if (pathname === "/v1/domains/replace") return replaceDomains(request, env);
    // Sites with notifications ctx.notify queued (notify.ts), for the
    // control plane's app-notifications job; ackNotifyOutbox takes a site off.
    if (pathname === "/v1/notifications/pending")
      return request.method === "POST"
        ? Response.json({ value: { sites: [...notifyPending] } })
        : failure(405, "Method not allowed.");
    // Sites with pauses the operators have not been told of (breaker.ts),
    // for the control plane's alerts; ackBreakerTrips takes a site off.
    if (pathname === "/v1/breakers/unnotified")
      return request.method === "POST"
        ? Response.json({ value: { sites: [...breakers.unnotified] } })
        : failure(405, "Method not allowed.");
    const pageview = /^\/v1\/pageviews\/([a-z]+)$/.exec(pathname);
    if (pageview) return pageviewOperation(request, env, pageview[1]);
    const match = /^\/v1\/sites\/([^/]+)\/([A-Za-z]+)$/.exec(pathname);
    const site = match && decodeURIComponent(match[1]);
    const operation = match?.[2] as Operation | undefined;
    const operations: readonly string[] =
      env.TEST_OPERATIONS === "1"
        ? [...OPERATIONS, ...TEST_OPERATIONS]
        : OPERATIONS;
    if (
      !env.SITES ||
      !site ||
      !SITE.test(site) ||
      !operations.includes(operation!)
    )
      return failure(404, "Not found.");
    if (request.method !== "POST") return failure(405, "Method not allowed.");
    let input: unknown;
    if (DUMP_OPERATIONS.includes(operation!)) {
      if (!request.body) return failure(400, "Expected a dump.");
      input = request.body;
    } else
      try {
        input = await request.json();
      } catch {
        return failure(400, "Expected a JSON body.");
      }
    // A restore point is read from (or written to) the site the URL names,
    // whose object this is, never one the body names.
    if (operation === "restoreFrom" || operation === "saveRestorePoint")
      input = { ...(input as object), site } satisfies { site: string };
    // A call or a render of the site's code: refused here when its function
    // is paused, else told the site's paused statements (breaker.ts).
    const call = callOf(operation!, input);
    if (call) {
      const admitted = admit(site, call);
      if (admitted.refusal)
        return Response.json(
          {
            error: {
              status: admitted.refusal.status,
              message: admitted.refusal.message,
              code: admitted.refusal.code,
              details: admitted.refusal.details,
              retryAfter: admitted.refusal.retryAfter,
            },
          },
          {
            status: admitted.refusal.status,
            headers: { "Retry-After": String(admitted.refusal.retryAfter) },
          },
        );
      input = { ...(input as object), site, paused: admitted.paused };
    }
    // The owner lets a paused statement (or all) run again: forgotten here,
    // and the object told what is still paused.
    if (operation === "clearBreaker") {
      const key = (input as { key?: unknown }).key;
      breakers.clear(site, typeof key === "string" ? key : undefined);
      input = {
        ...(input as object),
        paused: breakers.paused(site, Date.now()) satisfies Paused[],
      };
    }
    const stub = env.SITES.get(env.SITES.idFromName(site));
    // Each operation takes one argument object; the object validates it.
    let outcome: Outcome<unknown>;
    try {
      outcome = (await dispatch(
        stub,
        operation!,
        input as never,
      )) as Outcome<unknown>;
      if (call) settle(env.SITES, ctx, site, call);
    } catch (error) {
      if (call) settle(env.SITES, ctx, site, call, error);
      // A write the runtime stopped at its step budget reset the object
      // (sql.ts, `interrupted`): the site's own statement in a call or a
      // release's migrations, or one of Naru's.
      const refusal = interruptedCall(
        error,
        env,
        operation === "call"
          ? "site"
          : operation === "activateFunctions" ||
              operation === "putFunctions" ||
              operation === "trialMigrations"
            ? "migrations"
            : "naru",
      );
      if (!refusal) throw error;
      return failure(refusal.status, refusal.message, refusal);
    }
    // A new release's code starts with no statement paused.
    if (
      outcome.ok &&
      (operation === "activateFunctions" ||
        (operation === "putFunctions" &&
          (input as { publish?: unknown }).publish === true))
    )
      breakers.clear(site);
    if (outcome.ok && operation === "breakerTrips") {
      // Whether each is paused now: this Worker's memory, not the record.
      const paused = new Map(
        breakers
          .paused(site, Date.now())
          .map((pause) => [pause.key, pause.until]),
      );
      outcome = {
        ok: true,
        value: (outcome.value as { key: string; until: number }[]).map(
          (trip) => ({
            ...trip,
            pausedUntil:
              paused.get(trip.key) === trip.until ? trip.until : null,
          }),
        ),
      };
    }
    if (
      outcome.ok &&
      operation === "ackBreakerTrips" &&
      (outcome.value as { unnotified: number }).unnotified === 0
    )
      breakers.unnotified.delete(site);
    if (
      outcome.ok &&
      operation === "ackNotifyOutbox" &&
      (outcome.value as { pending: number }).pending === 0
    )
      notifyPending.delete(site);
    if (outcome.ok && operation === "dump")
      return new Response(outcome.value as ReadableStream<Uint8Array>, {
        headers: { "Content-Type": DUMP_CONTENT_TYPE },
      });
    return outcome.ok
      ? // JSON drops `undefined`; the caller tells success by `value`.
        Response.json({ value: outcome.value ?? null })
      : Response.json(
          { error: outcome.error },
          {
            status: outcome.error.status,
            headers: outcome.error.retryAfter
              ? { "Retry-After": String(outcome.error.retryAfter) }
              : {},
          },
        );
  },
  /** Each minute: the mini's health check (standby.ts). */
  async scheduled(_controller, env, ctx) {
    const standby = standbyObject(env);
    if (standby) ctx.waitUntil(standby.check());
  },
} satisfies ExportedHandler<Env>;
