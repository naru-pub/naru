import { publishSiteFunctions } from "@/lib/site-functions/releases";
import { db, requestDeadline } from "@/lib/database";
import { userHasFeature } from "@/lib/entitlements";
import { callSiteObject } from "@/lib/edge/client";
import { MEMBER_TOKEN, memberScope } from "./member-auth";
import { tokenScope } from "./owner-auth";
import { DataError, name, functionReference } from "./validation";

// Site databases live in Durable Objects, one per site, in the site-data
// Worker (edge/ at the repository root); the object applies every
// collection and document rule. What lives in PostgreSQL is decided here
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
  ids?: string;
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
export type Collection = CollectionSettings & { id: string };

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
      .select("id")
      .where("login_name", "=", command.site)
      .executeTakeFirst();
    if (!owner) throw noSite(command.site);
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
    return { owner, allowedIds, memberId };
  });
}

export async function executeData(command: DataCommand) {
  const { path, adminUserId } = command;
  if (path.length > 2) throw new DataError(404, "Not found.");
  path.forEach(name);
  const { owner, allowedIds, memberId } = await resolveSiteAccess(command);
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
        member: memberId ?? null,
      },
      path,
      method: command.method,
      body: command.body,
      filter: command.filter,
      size: command.size,
      sort: command.sort,
      after: command.after,
      includeTotal: command.includeTotal,
      ids: command.ids,
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
 * A member calls one of the site's functions: `path` is the module and the
 * function, `_naru/functions/<module>.js` and its export.
 */
export async function executeCall(command: DataCommand, readonly = false) {
  if (command.method !== "POST")
    throw new DataError(405, "Method not allowed.");
  const { file, fn } = functionReference(command.path.join("/"));
  const { owner, memberId } = await resolveSiteAccess(command);
  if (memberId === undefined)
    throw new DataError(
      command.bearer || command.adminUserId ? 403 : 401,
      "Site functions are called by signed-in members.",
    );
  const invoke = () =>
    callSiteObject<{ result: unknown }>(
      command.site,
      readonly ? "read" : "call",
      {
        ownerId: String(owner.id),
        site: command.site,
        member: memberId,
        file,
        name: fn,
        args: command.body?.args ?? null,
      },
      command.signal,
    );
  try {
    return await invoke();
  } catch (error) {
    if (
      !(error instanceof DataError) ||
      error.status !== 503 ||
      error.message !== "Site functions have not been published."
    )
      throw error;
    await publishSiteFunctions(command.site);
    return invoke();
  }
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
