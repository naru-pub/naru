import { publishSiteFunctions } from "@/lib/site-functions/releases";
import { db, requestDeadline } from "@/lib/database";
import { userHasFeature } from "@/lib/entitlements";
import { siteDataWorker, callSiteObject } from "@/lib/edge/client";
import { MEMBER_TOKEN, memberScope } from "./member-auth";
import { tokenScope } from "./owner-auth";
import { DataError, name, functionReference } from "./validation";
import { OWNER_TICKET, signLiveTicket } from "./live-ticket";

// Site databases live in Durable Objects, one per site, in the site-data
// Worker (edge/ at the repository root); the object applies every
// collection's access. What lives in PostgreSQL is decided here
// first: whether the site exists and has the database feature, and an owner
// token's scope, which renews the token. The object is then told the outcome.
//
// Visitors' requests usually never reach this: the Worker answers them at the
// edge. It sends here what it cannot answer itself.

export type DataCommand = {
  site: string;
  path: string[];
  method: string;
  adminUserId?: string;
  ownerMediaDelete?: boolean;
  // An owner's or a member's token. Mutable: tokenScope and memberScope
  // report the expiry the renewed token now has.
  bearer?: { token: string; origin: string | null; expiresAt?: number };
  clientIp?: string;
  /** Cancels the call to the Worker; a write the object began still settles. */
  signal?: AbortSignal;
  body?: Record<string, unknown>;
  /** Opaque cursor from the preceding page's nextCursor. */
  after?: string;
  size?: number;
  /** JSON array of one or two [field, direction] pairs. */
  sort?: string;
  filter?: unknown;
  includeTotal?: boolean;
  ifVersion?: number;
  /**
   * Filled in by the service when the response it produced is one any stranger
   * could have fetched, so the transport can let it be cached. Reported rather
   * than returned because it is metadata about the response, not part of it.
   */
  cacheability?: { public: boolean };
};

/** The account a site belongs to: its id, and its name, which is the site's. */
export type SiteOwner = { id: string; loginName: string };

export type CollectionSettings = {
  name: string;
  read_access: string;
  write_access: string;
};
export type Collection = CollectionSettings & {
  id: string;
  unique?: string[];
  indexes?: string[];
};
/** Settings _naru/collections.json asks for, applied on the owner's click. */
export type CollectionSetup = CollectionSettings & {
  unique?: string[];
  indexes?: string[];
};

export const noSite = (site: string) =>
  new DataError(404, `No Naru site is named ${site}.`);

/** The object reports times as ISO strings; callers here expect Dates. */
function withDates(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withDates);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === "data"
        ? item
        : (key === "createdAt" || key === "updatedAt") &&
            typeof item === "string"
          ? new Date(item)
          : withDates(item),
    ]),
  );
}

/**
 * The owner, whether the site has the database feature, and what the token
 * signs in (renewing it), in that order: an owner token's collections, or a
 * member token's member.
 */
export async function resolveSiteAccess(command: DataCommand) {
  return db.transaction().execute(async (tx) => {
    await requestDeadline(tx);
    const owner = await tx
      .selectFrom("users")
      .select(["id", "site_moderation"])
      .where("login_name", "=", command.site)
      .executeTakeFirst();
    if (!owner) throw noSite(command.site);
    // Operators stopped serving the site (site-moderation.ts).
    if (owner.site_moderation === "suspended")
      throw new DataError(403, "This site is suspended.");
    if (!(await userHasFeature(owner.id, "database", tx)))
      throw new DataError(403, "Database access is not enabled for this site.");
    const memberToken =
      command.bearer !== undefined && MEMBER_TOKEN.test(command.bearer.token);
    const allowedIds =
      command.bearer && !memberToken
        ? await tokenScope(tx, owner.id, command.bearer, {
            mediaDelete: command.ownerMediaDelete,
          })
        : undefined;
    const memberId = memberToken
      ? await memberScope(tx, owner.id, command.bearer!)
      : undefined;
    return { owner: { id: owner.id }, allowedIds, memberId };
  });
}

/**
 * Runs `invoke`, publishing the site's _naru files first if its object has no
 * revision of its code yet, which queries and mutations run from.
 */
async function withRevision<T>(site: string, invoke: () => Promise<T>) {
  try {
    return await invoke();
  } catch (error) {
    if (
      !(error instanceof DataError) ||
      error.status !== 503 ||
      error.message !== "Site functions have not been published."
    )
      throw error;
    await publishSiteFunctions(site);
    return invoke();
  }
}

export async function executeData(command: DataCommand) {
  const { path, adminUserId } = command;
  if (path.length > 2) throw new DataError(404, "Not found.");
  path.forEach(name);
  const { owner, allowedIds, memberId } = await resolveSiteAccess(command);
  // Collections are the owner's and visitors', as in SDK 1.0.0; members reach
  // the site's data through its queries and mutations.
  if (memberId !== undefined)
    throw new DataError(
      403,
      "Members reach a site's data through its queries and mutations, not its collections.",
      "ACCESS_DENIED",
    );
  const admin = adminUserId === owner.id || allowedIds !== undefined;
  if (adminUserId !== undefined && !admin)
    throw new DataError(403, "Permission denied.");
  const { result, publicRead } = await callSiteObject<{
    result: unknown;
    publicRead: boolean;
  }>(
    command.site,
    "execute",
    {
      ownerId: String(owner.id),
      site: command.site,
      access: {
        admin,
        allowedIds: allowedIds?.map(String) ?? null,
        anonymous: command.bearer === undefined && adminUserId === undefined,
      },
      path,
      method: command.method,
      body: command.body,
      filter: command.filter,
      size: command.size,
      sort: command.sort,
      after: command.after,
      includeTotal: command.includeTotal,
      ifVersion: command.ifVersion,
      clientIp: command.clientIp,
    },
    command.signal,
  );
  if (publicRead && command.cacheability) command.cacheability.public = true;
  return withDates(result);
}

export async function executeBatch(command: DataCommand) {
  if (command.method !== "POST")
    throw new DataError(405, "Method not allowed.");
  const operations = command.body?.operations;
  if (
    !Array.isArray(operations) ||
    !operations.length ||
    operations.length > 100
  )
    throw new DataError(400, "Batch requires 1–100 operations.");
  const { owner, allowedIds } = await resolveSiteAccess(command);
  if (allowedIds === undefined && command.adminUserId !== owner.id)
    throw new DataError(403, "A batch needs an owner sign-in.");
  return withDates(
    await callSiteObject(
      command.site,
      "batch",
      {
        ownerId: String(owner.id),
        allowedIds: allowedIds?.map(String) ?? null,
        operations,
      },
      command.signal,
    ),
  );
}

/**
 * A member, the site's owner with an owner token, or a visitor with no token
 * calls one of the site's queries or mutations: `path` is the module and the
 * export, `_naru/queries/<module>.js` or `_naru/mutations/<module>.js`. The
 * edge usually answers visitors itself (website.ts), and sends here what it
 * cannot. The code decides who may do what, whatever collections the
 * owner's sign-in approved.
 */
export async function executeCall(
  command: DataCommand & { kind: "query" | "mutation" },
) {
  if (command.method !== "POST")
    throw new DataError(405, "Method not allowed.");
  const { file, fn } = functionReference(command.path.join("/"));
  const { owner, memberId, allowedIds } = await resolveSiteAccess(command);
  if (command.adminUserId !== undefined)
    throw new DataError(
      403,
      "A site's queries and mutations are called from its pages, not the control panel.",
    );
  const visitor = memberId === undefined && allowedIds === undefined;
  const { result } = await withRevision(command.site, () =>
    callSiteObject<{ result: unknown }>(
      command.site,
      "call",
      {
        ownerId: String(owner.id),
        site: command.site,
        member: memberId ?? null,
        ...(visitor ? { visitor: true, clientIp: command.clientIp } : {}),
        file,
        name: fn,
        args: command.body?.args ?? null,
        kind: command.kind,
      },
      command.signal,
    ),
  );
  return { result };
}

/**
 * A member's ticket onto the site's live connection: the WebSocket they open
 * next at the edge, whose live queries then run as them.
 */
export async function executeLiveTicket(command: DataCommand) {
  if (command.method !== "POST")
    throw new DataError(405, "Method not allowed.");
  const { memberId, allowedIds } = await resolveSiteAccess(command);
  // The owner's page subscribes as the owner (ctx.owner), on a ticket of
  // its own: OWNER_TICKET names no member.
  if (
    memberId === undefined &&
    (allowedIds === undefined || command.adminUserId !== undefined)
  )
    throw new DataError(
      command.bearer ? 403 : 401,
      "Live tickets are for signed-in members and the site's owner; visitors connect without one.",
    );
  // Checked by the Worker that holds the site's object (edge/client.ts).
  const { secret } = siteDataWorker();
  if (!secret) throw new DataError(503, "Live connections are unavailable.");
  return {
    ticket: await signLiveTicket(
      secret,
      command.site,
      memberId ?? OWNER_TICKET,
    ),
  };
}

/** A site's collections by name, or all of them, ordered by name. */
export async function listCollections(
  owner: SiteOwner,
  names?: string[],
): Promise<Collection[]> {
  if (names?.length === 0) return [];
  return callSiteObject<Collection[]>(owner.loginName, "collections", {
    names,
  });
}

/**
 * Creates the collections a site lacks, empty, all or none: when they would
 * take the site past the collection limit nothing is created and this
 * returns null. Otherwise the names actually created; one that already exists
 * is left as is. Commits on its own, whatever transaction the caller holds.
 */
export async function createCollections(
  owner: SiteOwner,
  collections: CollectionSettings[],
): Promise<string[] | null> {
  if (!collections.length) return [];
  return callSiteObject<string[] | null>(owner.loginName, "createCollections", {
    ownerId: String(owner.id),
    collections,
  });
}

/**
 * Creates or updates collections to the given settings, all or none: null
 * when new ones would pass the collection limit. Returns the names created.
 * A unique field documents already share fails the whole change (CONFLICT).
 */
export async function configureCollections(
  owner: SiteOwner,
  collections: CollectionSetup[],
): Promise<string[] | null> {
  if (!collections.length) return [];
  return callSiteObject<string[] | null>(
    owner.loginName,
    "configureCollections",
    { ownerId: String(owner.id), collections },
  );
}
