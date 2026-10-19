// A site's code, `<login>/_naru/` (queries, mutations, routes, migrations,
// collections.json), is the site's own files in every way but one: it is
// kept in the private bucket, which no public domain serves, rather than the
// site bucket, which r2.<domain> serves whole. `_naru/shared/`, code the
// site's pages import as well as its functions, stays with the site's files
// (docs/sdk-v1-api.md). Everything that handles a site's files (the
// file manager, uploads, GitHub deploys, exports, account deletion,
// suspension) names the site bucket as before; the shared S3 client (s3.ts)
// sends what it asks of site code to the private bucket instead:
//
//   - a single object's command (get, put, head, delete, multipart upload,
//     presigned URLs too) goes to whichever bucket holds its key;
//   - a copy reads its source from where that key is kept, so a file can be
//     moved into or out of `_naru/`;
//   - a batch delete is split between the two;
//   - a listing that could include site code (a home folder, its root, the
//     whole bucket) lists both, the site bucket's pages first. A page that
//     ends one bucket's listing has the other's first page with it, so a
//     small folder still comes back as one sorted page. Site code the site
//     bucket still holds is a stale copy from before the move, left out.
//
// So site code can never land in the site bucket, whichever code writes it.
// A suspended site's (`_suspended/<login>/_naru/`) stays private too.

const SITE_CODE = /^(?:_suspended\/)?[^/]+\/_naru(?:$|\/(?!shared\/))/;

/** Whether `key` of the site bucket is site code, kept in the private one. */
export const isSiteCode = (key: string) => SITE_CODE.test(key);

/**
 * Whether a listing of the site bucket under `prefix` could find site code:
 * false when it is all site files, "only" when it is all site code.
 */
export function listsSiteCode(prefix: string): boolean | "only" {
  const rest = prefix.startsWith("_suspended/")
    ? prefix.slice("_suspended/".length)
    : prefix;
  const slash = rest.indexOf("/");
  if (slash < 0) return true;
  const inside = rest.slice(slash + 1);
  if (!inside.startsWith("_naru/")) return "_naru/".startsWith(inside);
  const folder = inside.slice("_naru/".length);
  if (folder.startsWith("shared/")) return false;
  return "shared/".startsWith(folder) || "only";
}

function decodedKey(path: string) {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

type Buckets = { site: () => string; private: () => string };
type Args = { input: Record<string, any> };
type Next = (args: Args) => Promise<{ output: any; response?: unknown }>;

// Our own continuation tokens: which bucket a listing goes on with.
const SITE_TOKEN = "site:";
const PRIVATE_TOKEN = "private:";

/** The S3 client's middleware (initialize step) that does the routing. */
export function siteCodeRouting(buckets: Buckets) {
  return (next: Next, context: { commandName?: string }) =>
    async (args: Args) => {
      const input = args.input;
      const site = buckets.site();
      const withInput = (changes: Record<string, unknown>) =>
        next({ ...args, input: { ...input, ...changes } });

      if (typeof input.CopySource === "string") {
        // "<bucket>/<key>[?versionId=...]", the key encoded or not.
        const source = (input.CopySource as string).replace(/^\//, "");
        const slash = source.indexOf("/");
        const key = decodedKey(source.slice(slash + 1).split("?")[0]);
        if (source.slice(0, slash) === site && isSiteCode(key))
          return withInput({
            CopySource: `${buckets.private()}${source.slice(slash)}`,
            ...(input.Bucket === site && isSiteCode(input.Key)
              ? { Bucket: buckets.private() }
              : {}),
          });
      }
      if (input.Bucket !== site) return next(args);

      if (context.commandName === "ListObjectsV2Command")
        return listBoth(buckets, input, withInput);
      if (context.commandName === "DeleteObjectsCommand")
        return deleteBoth(buckets, input, withInput);
      if (typeof input.Key === "string" && isSiteCode(input.Key))
        return withInput({ Bucket: buckets.private() });
      return next(args);
    };
}

async function listBoth(
  buckets: Buckets,
  input: Record<string, any>,
  withInput: (changes: Record<string, unknown>) => ReturnType<Next>,
) {
  const reach = listsSiteCode(input.Prefix ?? "");
  const token: string | undefined = input.ContinuationToken;
  if (!reach) return withInput({});
  if (reach === "only")
    return withInput({
      Bucket: buckets.private(),
      ContinuationToken: token?.startsWith(PRIVATE_TOKEN)
        ? token.slice(PRIVATE_TOKEN.length) || undefined
        : token,
    });

  // Each bucket's side only: the private bucket's own files
  // (`_naru-runtime/`) are no site's, and site code the site bucket still
  // has is a stale copy from before the move.
  const filtered = (
    result: Awaited<ReturnType<Next>>,
    code: boolean,
  ): Awaited<ReturnType<Next>> => {
    const output = result.output;
    const contents = (output.Contents ?? []).filter(
      ({ Key }: any) => isSiteCode(Key) === code,
    );
    const prefixes = (output.CommonPrefixes ?? []).filter(({ Prefix }: any) =>
      code
        ? !Prefix.startsWith("_naru-runtime/") &&
          listsSiteCode(Prefix) !== false
        : listsSiteCode(Prefix) !== "only",
    );
    return {
      ...result,
      output: {
        ...output,
        Contents: contents.length ? contents : undefined,
        CommonPrefixes: prefixes.length ? prefixes : undefined,
        KeyCount: contents.length + prefixes.length,
      },
    };
  };
  const listPrivate = async (cursor: string | undefined) =>
    filtered(
      await withInput({ Bucket: buckets.private(), ContinuationToken: cursor }),
      true,
    );
  if (token?.startsWith(PRIVATE_TOKEN)) {
    const result = await listPrivate(
      token.slice(PRIVATE_TOKEN.length) || undefined,
    );
    return tokened(result, PRIVATE_TOKEN);
  }
  const result = filtered(
    await withInput({
      ContinuationToken: token?.startsWith(SITE_TOKEN)
        ? token.slice(SITE_TOKEN.length)
        : undefined,
    }),
    false,
  );
  if (result.output.IsTruncated) return tokened(result, SITE_TOKEN);
  // The site bucket is done: the private one's first page goes with it.
  const rest = await listPrivate(undefined);
  const output = result.output;
  const contents = [
    ...(output.Contents ?? []),
    ...(rest.output.Contents ?? []),
  ];
  const seen = new Set<string>();
  const prefixes = [
    ...(output.CommonPrefixes ?? []),
    ...(rest.output.CommonPrefixes ?? []),
  ].filter(({ Prefix }) => !seen.has(Prefix) && !!seen.add(Prefix));
  contents.sort((a, b) => (a.Key < b.Key ? -1 : a.Key > b.Key ? 1 : 0));
  prefixes.sort((a, b) =>
    a.Prefix < b.Prefix ? -1 : a.Prefix > b.Prefix ? 1 : 0,
  );
  return tokened(
    {
      ...result,
      output: {
        ...output,
        Contents: contents.length ? contents : undefined,
        CommonPrefixes: prefixes.length ? prefixes : undefined,
        KeyCount: contents.length + prefixes.length,
        IsTruncated: !!rest.output.IsTruncated,
        NextContinuationToken: rest.output.NextContinuationToken,
      },
    },
    PRIVATE_TOKEN,
  );
}

/** The result, its next token (if any) marked with the bucket it is for. */
function tokened(
  result: Awaited<ReturnType<Next>>,
  mark: string,
): Awaited<ReturnType<Next>> {
  const output = result.output;
  return {
    ...result,
    output: {
      ...output,
      NextContinuationToken: output.IsTruncated
        ? `${mark}${output.NextContinuationToken ?? ""}`
        : undefined,
    },
  };
}

async function deleteBoth(
  buckets: Buckets,
  input: Record<string, any>,
  withInput: (changes: Record<string, unknown>) => ReturnType<Next>,
) {
  const objects: { Key: string }[] = input.Delete?.Objects ?? [];
  const code = objects.filter(({ Key }) => isSiteCode(Key));
  if (!code.length) return withInput({});
  const files = objects.filter(({ Key }) => !isSiteCode(Key));
  const inPrivate = await withInput({
    Bucket: buckets.private(),
    Delete: { ...input.Delete, Objects: code },
  });
  if (!files.length) return inPrivate;
  const inSite = await withInput({
    Delete: { ...input.Delete, Objects: files },
  });
  const merge = (field: "Deleted" | "Errors") => {
    const all = [
      ...(inSite.output[field] ?? []),
      ...(inPrivate.output[field] ?? []),
    ];
    return all.length ? all : undefined;
  };
  return {
    ...inSite,
    output: {
      ...inSite.output,
      Deleted: merge("Deleted"),
      Errors: merge("Errors"),
    },
  };
}
