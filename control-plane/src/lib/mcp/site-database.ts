import { userHasFeature } from "@/lib/entitlements";
import {
  DECLARATION_PATH,
  declaredPlan,
  parseDeclaration,
} from "@/lib/site-data/declared-collections";
import type { CollectionRequest } from "@/lib/site-data/owner-auth";
import { decodeRevision, publicResult } from "@/lib/site-data/protocol";
import { executeData } from "@/lib/site-data/service";
import { DataError } from "@/lib/site-data/validation";
import {
  FileError,
  listFiles,
  readFile,
  writeFile,
  type Site,
} from "./site-files";

// A site's database as Naru MCP's tools reach it: what SDK 1.0.0 gives the
// site's signed-in owner (Admin), its collections and their documents, by
// the same path as the control panel's /database (site-data/service.ts).
// Revisions go out and come back as the SDK's opaque strings. Collections
// change only through the site's declaration, so what would open one wider
// still waits for the owner on /database (declared-collections.ts).

/** `{ revision }` or `{ absent: true }`, as SDK 1.0.0's WriteCondition. */
export type WriteCondition = { revision: string } | { absent: true };

function ifVersion(condition: WriteCondition | undefined) {
  if (!condition) return undefined;
  return "absent" in condition ? 0 : decodeRevision(condition.revision);
}

async function run(
  site: Site,
  path: string[],
  method: string,
  extra: Partial<Parameters<typeof executeData>[0]> = {},
) {
  // As dataRequest refuses every request while site databases move hosts.
  if (process.env.SITE_DATA_MAINTENANCE === "1")
    throw new DataError(
      503,
      "Site data is moving. Try again in a few minutes.",
      "UNAVAILABLE",
    );
  return publicResult(
    await executeData({
      site: site.loginName,
      path,
      method,
      adminUserId: site.userId,
      ...extra,
    }),
  );
}

/** The site's collections, who may read and write each, and its usage. */
export const listCollections = (site: Site) => run(site, [], "GET");

export const listDocuments = (
  site: Site,
  collection: string,
  options: {
    filter?: unknown;
    sort?: unknown;
    size?: number;
    after?: string;
    includeTotal?: boolean;
  },
) =>
  run(site, [collection], "GET", {
    filter: options.filter,
    sort: options.sort === undefined ? undefined : JSON.stringify(options.sort),
    size: options.size,
    after: options.after,
    includeTotal: options.includeTotal,
  });

export const getDocument = async (site: Site, collection: string, id: string) =>
  ((await run(site, [collection, id], "GET")) as { document: unknown })
    .document;

/** Replaces or creates the document `id`, or adds one with a new id. */
export const setDocument = (
  site: Site,
  collection: string,
  id: string | undefined,
  data: unknown,
  condition?: WriteCondition,
) =>
  id === undefined
    ? run(site, [collection], "POST", { body: { data } })
    : run(site, [collection, id], "PUT", {
        body: { data },
        ifVersion: ifVersion(condition),
      });

/** Deleting a missing document succeeds unless a revision was given. */
export const deleteDocument = async (
  site: Site,
  collection: string,
  id: string,
  revision?: string,
) => {
  await run(site, [collection, id], "DELETE", {
    ifVersion: revision === undefined ? undefined : decodeRevision(revision),
  });
};

/** The declaration's JSON as the site has it, or a new one. */
async function declarationJson(site: Site): Promise<Record<string, unknown>> {
  const { files } = await listFiles(site, "_naru/");
  if (!files.some((file) => file.path === DECLARATION_PATH))
    return { collections: {} };
  const file = await readFile(site, DECLARATION_PATH);
  if (file.kind !== "text")
    throw new FileError(`${DECLARATION_PATH} is too large to change here.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.text);
  } catch {
    throw new FileError(
      `${DECLARATION_PATH} is not valid JSON. Fix it with write_file first.`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new FileError(`${DECLARATION_PATH} must be a JSON object.`);
  return parsed as Record<string, unknown>;
}

/**
 * Declares `collections` in _naru/collections.json, each replacing its entry
 * whole and the file's other entries kept, and saves it, which installs it:
 * new collections are created and index changes applied at once, while
 * changes to an existing collection's access or unique fields wait for the
 * owner. Returns what happened to each.
 */
export async function configureCollections(
  site: Site,
  collections: Record<string, CollectionRequest>,
) {
  if (!(await userHasFeature(site.userId, "database")))
    throw new DataError(403, "Database access is not enabled for this site.");
  const json = await declarationJson(site);
  const existing = json.collections;
  const merged = {
    ...json,
    collections: {
      ...(existing && typeof existing === "object" && !Array.isArray(existing)
        ? existing
        : {}),
      ...collections,
    },
  };
  const text = `${JSON.stringify(merged, null, 2)}\n`;
  // Refuses what the install would, before the file is saved.
  const declared = parseDeclaration(text);
  const owner = { id: site.userId, loginName: site.loginName };
  const before = await declaredPlan(owner, declared);
  await writeFile(site, DECLARATION_PATH, Buffer.from(text));
  const after = await declaredPlan(owner, declared);
  return {
    created: before.create.filter((name) => !after.create.includes(name)),
    notCreated: after.create,
    waitingForOwner: after.configure,
  };
}
