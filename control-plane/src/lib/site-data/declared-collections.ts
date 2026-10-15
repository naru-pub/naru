import { GetObjectCommand } from "@aws-sdk/client-s3";
import { db } from "@/lib/database";
import { userHasFeature } from "@/lib/entitlements";
import { s3Client } from "@/lib/s3";
import { getUserObjectKey } from "@/lib/site-urls";
import {
  collectionRequests,
  settingChanges,
  type CollectionRequest,
} from "./owner-auth";
import {
  configureCollections,
  listCollections,
  type CollectionSetup,
  type SiteOwner,
} from "./service";
import { DataError, unreservedName } from "./validation";

// A site declares the collections it needs in _naru/collections.json, beside
// the functions and rules that use them, and Naru installs them as the files
// arrive (cache-purge.ts): a template applied, a GitHub deploy, a save in the
// editor. Missing collections are created at once, since the owner put the
// files on their own site. A declaration that would change an existing
// collection (its access, rules or unique fields) waits for the owner on
// /database, so nothing is widened without being seen.
//
//   { "collections": { "guestbook": { "read": "world", "write": "create" },
//                      "settings": {} } }
//
// Each collection takes read, write, rules and unique as a sign-in's settings
// do; one left empty is admin-only, like any new collection.

export const DECLARATION_PATH = "_naru/collections.json";
const MAX_BYTES = 64 * 1024;

export type DeclaredPlan = {
  /** Declared collections the site does not have yet. */
  create: string[];
  /** Existing collections the declaration would change, as [now, declared]. */
  configure: { name: string; changes: Record<string, [string, string]> }[];
};

/** A declaration's collections and their settings, validated. */
export function parseDeclaration(
  text: string,
): Record<string, CollectionRequest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DataError(400, `${DECLARATION_PATH} is not valid JSON.`);
  }
  const collections =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as { collections?: unknown }).collections
      : undefined;
  if (
    !collections ||
    typeof collections !== "object" ||
    Array.isArray(collections)
  )
    throw new DataError(
      400,
      `${DECLARATION_PATH} must have a "collections" object.`,
    );
  const names = Object.keys(collections);
  if (!names.length || names.length > 100)
    throw new DataError(400, `${DECLARATION_PATH} declares 1–100 collections.`);
  names.forEach(unreservedName);
  return collectionRequests(collections, names);
}

/** The site's declaration, or null when it has none. */
export async function readDeclaration(loginName: string) {
  let text: string;
  try {
    const object = await s3Client.send(
      new GetObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME!,
        Key: getUserObjectKey(loginName, DECLARATION_PATH),
      }),
    );
    if ((object.ContentLength ?? 0) > MAX_BYTES)
      throw new DataError(400, `${DECLARATION_PATH} is over 64 KiB.`);
    text = (await object.Body?.transformToString()) ?? "";
  } catch (error) {
    if ((error as { name?: string }).name === "NoSuchKey") return null;
    if (
      (error as { $metadata?: { httpStatusCode?: number } }).$metadata
        ?.httpStatusCode === 404
    )
      return null;
    throw error;
  }
  return parseDeclaration(text);
}

/** What installing `declared` on the site would create and change. */
export async function declaredPlan(
  owner: SiteOwner,
  declared: Record<string, CollectionRequest>,
): Promise<DeclaredPlan> {
  const names = Object.keys(declared);
  const rows = await listCollections(owner, names);
  return {
    create: names.filter((name) => !rows.some((row) => row.name === name)),
    configure: rows.flatMap((row) => {
      const changes = settingChanges(row, declared[row.name]);
      return Object.keys(changes).length ? [{ name: row.name, changes }] : [];
    }),
  };
}

const setup = (name: string, wanted: CollectionRequest): CollectionSetup => ({
  name,
  read_access: wanted.read,
  write_access: wanted.write,
  ...(wanted.rules !== undefined ? { rules: wanted.rules } : {}),
  ...(wanted.unique !== undefined ? { unique: wanted.unique } : {}),
});

async function apply(
  owner: SiteOwner,
  declared: Record<string, CollectionRequest>,
  names: string[],
) {
  if (!names.length) return [];
  const created = await configureCollections(
    owner,
    names.map((name) => setup(name, declared[name])),
  );
  if (created === null)
    throw new DataError(409, "Collection limit reached.", "QUOTA_EXCEEDED");
  return created;
}

async function ownerOf(loginName: string): Promise<SiteOwner | null> {
  const row = await db
    .selectFrom("users")
    .select(["id", "login_name as loginName"])
    .where("login_name", "=", loginName)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  return row ? { id: String(row.id), loginName: row.loginName } : null;
}

/**
 * As the declaration arrives: creates the collections the site lacks, with
 * their settings, and leaves changes to existing ones for the owner. Sites
 * without the database feature are skipped.
 */
export async function installDeclaredCollections(loginName: string) {
  const owner = await ownerOf(loginName);
  if (!owner || !(await userHasFeature(owner.id, "database"))) return null;
  const declared = await readDeclaration(loginName);
  if (!declared) return null;
  const plan = await declaredPlan(owner, declared);
  const created = await apply(owner, declared, plan.create);
  return { created, pending: plan.configure };
}

/** The declaration's plan for the owner's /database page. */
export async function pendingDeclaration(owner: SiteOwner) {
  const declared = await readDeclaration(owner.loginName);
  return declared ? declaredPlan(owner, declared) : null;
}

/** The owner approves: everything the declaration asks, created and changed. */
export async function applyDeclaration(owner: SiteOwner) {
  const declared = await readDeclaration(owner.loginName);
  if (!declared)
    throw new DataError(404, `This site has no ${DECLARATION_PATH}.`);
  const plan = await declaredPlan(owner, declared);
  return apply(owner, declared, [
    ...plan.create,
    ...plan.configure.map((c) => c.name),
  ]);
}
