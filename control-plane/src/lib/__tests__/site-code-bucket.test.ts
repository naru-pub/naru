/** @jest-environment node */
import { beforeEach, describe, expect, test } from "@jest/globals";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "stream";
import {
  isPrivateKey,
  isSiteCode,
  listsPrivate,
  listsSiteCode,
  siteCodeRouting,
} from "@/lib/site-code-bucket";

// Two in-memory buckets behind a real S3 client, so that the routing is
// checked through the SDK as the control plane uses it.
const SITE = "test-bucket";
const PRIVATE = "test-private-bucket";
let buckets: Map<string, Map<string, string>>;

const xml = (body: string) => ({
  response: {
    statusCode: 200,
    headers: { "content-type": "application/xml" },
    body: Readable.from([Buffer.from(body)]),
  },
});
const escape = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function list(bucket: string, query: Record<string, string>) {
  const prefix = query.prefix ?? "";
  const delimiter = query.delimiter;
  const max = Number(query["max-keys"] ?? 1000);
  const after = query["continuation-token"] ?? "";
  const keys = [...buckets.get(bucket)!.keys()]
    .filter((key) => key.startsWith(prefix) && key > after)
    .sort();
  const contents: string[] = [];
  const prefixes = new Set<string>();
  let last = "";
  let truncated = false;
  for (const key of keys) {
    if (contents.length + prefixes.size >= max) {
      truncated = true;
      break;
    }
    const cut = delimiter ? key.indexOf(delimiter, prefix.length) : -1;
    if (cut >= 0) prefixes.add(key.slice(0, cut + 1));
    else contents.push(key);
    last = key;
  }
  return xml(
    `<ListBucketResult><Name>${bucket}</Name><Prefix>${escape(prefix)}</Prefix>` +
      `<KeyCount>${contents.length + prefixes.size}</KeyCount><IsTruncated>${truncated}</IsTruncated>` +
      (truncated
        ? `<NextContinuationToken>${escape(last)}</NextContinuationToken>`
        : "") +
      contents
        .map(
          (key) =>
            `<Contents><Key>${escape(key)}</Key><Size>${buckets.get(bucket)!.get(key)!.length}</Size></Contents>`,
        )
        .join("") +
      [...prefixes]
        .map(
          (value) =>
            `<CommonPrefixes><Prefix>${escape(value)}</Prefix></CommonPrefixes>`,
        )
        .join("") +
      `</ListBucketResult>`,
  );
}

const text = async (body: unknown) =>
  typeof body === "string"
    ? body
    : Buffer.isBuffer(body) || body instanceof Uint8Array
      ? Buffer.from(body).toString()
      : body
        ? Buffer.concat(
            await (body as Readable)
              .toArray()
              .then((parts) => parts.map((part) => Buffer.from(part))),
          ).toString()
        : "";

const client = new S3Client({
  region: "auto",
  endpoint: "http://r2.test",
  forcePathStyle: true,
  credentials: { accessKeyId: "id", secretAccessKey: "secret" },
  requestHandler: {
    async handle(request: any) {
      const [, bucket, ...rest] = request.path.split("/");
      const key = decodeURIComponent(rest.join("/"));
      const store = buckets.get(bucket)!;
      const query = request.query ?? {};
      if (request.method === "GET" && "list-type" in query)
        return list(bucket, query);
      if (request.method === "POST" && "delete" in query) {
        const body = await text(request.body);
        const keys = [...body.matchAll(/<Key>([^<]*)<\/Key>/g)].map((match) =>
          match[1]
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&amp;/g, "&"),
        );
        for (const deleted of keys) store.delete(deleted);
        return xml(
          `<DeleteResult>${keys.map((deleted) => `<Deleted><Key>${escape(deleted)}</Key></Deleted>`).join("")}</DeleteResult>`,
        );
      }
      if (request.method === "PUT" && request.headers["x-amz-copy-source"]) {
        const source = decodeURIComponent(request.headers["x-amz-copy-source"]);
        const slash = source.indexOf("/");
        const value = buckets
          .get(source.slice(0, slash))!
          .get(source.slice(slash + 1));
        if (value === undefined) throw new Error(`no ${source}`);
        store.set(key, value);
        return xml(`<CopyObjectResult><ETag>"e"</ETag></CopyObjectResult>`);
      }
      if (request.method === "PUT") {
        store.set(key, await text(request.body));
        return xml("");
      }
      if (request.method === "DELETE") {
        store.delete(key);
        return {
          response: { statusCode: 204, headers: {}, body: Readable.from([]) },
        };
      }
      if (request.method === "GET") {
        const value = store.get(key);
        if (value === undefined)
          return {
            response: {
              statusCode: 404,
              headers: {},
              body: Readable.from([
                Buffer.from("<Error><Code>NoSuchKey</Code></Error>"),
              ]),
            },
          };
        return {
          response: {
            statusCode: 200,
            headers: {},
            body: Readable.from([Buffer.from(value)]),
          },
        };
      }
      throw new Error(`unexpected ${request.method} ${request.path}`);
    },
  } as never,
});
client.middlewareStack.add(
  siteCodeRouting({ site: () => SITE, private: () => PRIVATE }) as never,
  { step: "initialize", name: "siteCodeRouting" },
);

const keys = (bucket: string) => [...buckets.get(bucket)!.keys()].sort();

beforeEach(() => {
  buckets = new Map([
    [SITE, new Map()],
    [PRIVATE, new Map()],
  ]);
});

describe("which keys are site code", () => {
  test.each([
    ["alice/_naru/queries/board.js", true],
    ["alice/_naru/collections.json", true],
    ["alice/_naru", true],
    ["_suspended/alice/_naru/routes.js", true],
    ["alice/_naru.html", false],
    ["alice/blog/_naru/queries/board.js", false],
    ["alice/index.html", false],
    ["_naru-runtime/alice/routes.json", false],
    ["__deploy_uploads/1/2/_naru/x.js", false],
  ])("%s → %s", (key, expected) => {
    expect(isSiteCode(key)).toBe(expected);
  });

  test.each([
    ["", true],
    ["alice", true],
    ["alice/", true],
    ["alice/_na", true],
    ["alice/_naru/", "only"],
    ["alice/_naru/queries/", "only"],
    ["alice/blog/", false],
    ["alice/index", false],
    ["_suspended/alice/", true],
    ["_suspended/alice/_naru/", "only"],
    ["_screenshots/", true],
    ["_screenshots/alice", false],
    ["__deploy_uploads/1/", false],
  ])("listing %j reaches site code: %s", (prefix, expected) => {
    expect(listsSiteCode(prefix)).toBe(expected);
  });

  // A template version's files are private too; its previews are not.
  test.each([
    ["_templates/t1/v3/index.html", true],
    ["_templates/t1/v12/css/a.css", true],
    ["_templates/t1/v3.png", false],
    ["_templates/t1/preview", false],
    ["alice/_naru/routes.js", true],
    ["alice/index.html", false],
  ])("%s is private: %s", (key, expected) => {
    expect(isPrivateKey(key)).toBe(expected);
  });

  test.each([
    ["", true],
    ["_templates/", true],
    ["_templates/t1/", true],
    ["_templates/t1/v3", true],
    ["_templates/t1/v3/", "only"],
    ["_templates/t1/preview", false],
    ["_templates/t1/v3.png", false],
    ["alice/_naru/", "only"],
    ["alice/blog/", false],
  ])("listing %j reaches private keys: %s", (prefix, expected) => {
    expect(listsPrivate(prefix)).toBe(expected);
  });
});

test("writes, reads and deletes site code in the private bucket only", async () => {
  await client.send(
    new PutObjectCommand({
      Bucket: SITE,
      Key: "alice/_naru/queries/a.js",
      Body: "q",
    }),
  );
  await client.send(
    new PutObjectCommand({
      Bucket: SITE,
      Key: "alice/index.html",
      Body: "page",
    }),
  );
  expect(keys(SITE)).toEqual(["alice/index.html"]);
  expect(keys(PRIVATE)).toEqual(["alice/_naru/queries/a.js"]);

  const object = await client.send(
    new GetObjectCommand({ Bucket: SITE, Key: "alice/_naru/queries/a.js" }),
  );
  expect(await object.Body!.transformToString()).toBe("q");

  await client.send(
    new DeleteObjectCommand({ Bucket: SITE, Key: "alice/_naru/queries/a.js" }),
  );
  expect(keys(PRIVATE)).toEqual([]);
});

test("keeps template versions' files private, beside public previews", async () => {
  buckets.get(SITE)!.set("alice/index.html", "page");
  // Snapshotting a site into a version, then applying it to another site.
  await client.send(
    new CopyObjectCommand({
      Bucket: SITE,
      CopySource: `${SITE}/alice/index.html`,
      Key: "_templates/t1/v1/index.html",
    }),
  );
  await client.send(
    new PutObjectCommand({
      Bucket: SITE,
      Key: "_templates/t1/v1.png",
      Body: "png",
    }),
  );
  await client.send(
    new CopyObjectCommand({
      Bucket: SITE,
      CopySource: `${SITE}/_templates/t1/v1/index.html`,
      Key: "bob/index.html",
    }),
  );
  expect(keys(SITE)).toEqual([
    "_templates/t1/v1.png",
    "alice/index.html",
    "bob/index.html",
  ]);
  expect(keys(PRIVATE)).toEqual(["_templates/t1/v1/index.html"]);

  const listed = await client.send(
    new ListObjectsV2Command({ Bucket: SITE, Prefix: "_templates/t1/" }),
  );
  expect(listed.Contents?.map((object) => object.Key)).toEqual([
    "_templates/t1/v1.png",
    "_templates/t1/v1/index.html",
  ]);
});

test("leaves other buckets alone", async () => {
  buckets.set("other", new Map());
  await client.send(
    new PutObjectCommand({
      Bucket: "other",
      Key: "alice/_naru/a.js",
      Body: "x",
    }),
  );
  expect(keys("other")).toEqual(["alice/_naru/a.js"]);
});

test("copies into, out of and within _naru/ across the buckets", async () => {
  buckets.get(SITE)!.set("__deploy_uploads/u/d/abc", "staged");
  buckets.get(SITE)!.set("alice/old.js", "file");
  await client.send(
    new CopyObjectCommand({
      Bucket: SITE,
      CopySource: `${SITE}/${encodeURIComponent("__deploy_uploads/u/d/abc")}`,
      Key: "alice/_naru/queries/a.js",
    }),
  );
  await client.send(
    new CopyObjectCommand({
      Bucket: SITE,
      CopySource: `${SITE}/alice/old.js`,
      Key: "alice/_naru/modules/old.js",
    }),
  );
  await client.send(
    new CopyObjectCommand({
      Bucket: SITE,
      CopySource: `${SITE}/alice/_naru/queries/a.js`,
      Key: "alice/a.js",
    }),
  );
  await client.send(
    new CopyObjectCommand({
      Bucket: SITE,
      CopySource: `${SITE}/alice/_naru/queries/a.js`,
      Key: "_suspended/alice/_naru/queries/a.js",
    }),
  );
  expect(keys(SITE)).toEqual([
    "__deploy_uploads/u/d/abc",
    "alice/a.js",
    "alice/old.js",
  ]);
  expect(keys(PRIVATE)).toEqual([
    "_suspended/alice/_naru/queries/a.js",
    "alice/_naru/modules/old.js",
    "alice/_naru/queries/a.js",
  ]);
});

test("splits a batch delete between the buckets", async () => {
  buckets.get(SITE)!.set("alice/index.html", "p");
  buckets.get(PRIVATE)!.set("alice/_naru/queries/a.js", "q");
  buckets.get(PRIVATE)!.set("_naru-runtime/alice/routes.json", "r");
  const result = await client.send(
    new DeleteObjectsCommand({
      Bucket: SITE,
      Delete: {
        Objects: [
          { Key: "alice/index.html" },
          { Key: "alice/_naru/queries/a.js" },
        ],
      },
    }),
  );
  expect(result.Deleted?.map(({ Key }) => Key).sort()).toEqual([
    "alice/_naru/queries/a.js",
    "alice/index.html",
  ]);
  expect(keys(SITE)).toEqual([]);
  expect(keys(PRIVATE)).toEqual(["_naru-runtime/alice/routes.json"]);
});

async function listAll(input: {
  Prefix?: string;
  Delimiter?: string;
  MaxKeys?: number;
}) {
  const pages: { keys: string[]; prefixes: string[] }[] = [];
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: SITE,
        ...input,
        ContinuationToken: token,
      }),
    );
    pages.push({
      keys: (page.Contents ?? []).map(({ Key }) => Key!),
      prefixes: (page.CommonPrefixes ?? []).map(({ Prefix }) => Prefix!),
    });
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return pages;
}

describe("listing a home folder", () => {
  beforeEach(() => {
    for (const key of [
      "alice/index.html",
      "alice/css/a.css",
      "alice/z.html",
      "bob/index.html",
    ])
      buckets.get(SITE)!.set(key, "x");
    for (const key of [
      "alice/_naru/queries/a.js",
      "alice/_naru/routes.json",
      "bob/_naru/queries/b.js",
      "_naru-runtime/alice/routes.json",
    ])
      buckets.get(PRIVATE)!.set(key, "x");
  });

  test("returns both buckets' objects as one sorted page", async () => {
    // Stale, from before the move: not listed.
    buckets.get(SITE)!.set("alice/_naru/queries/stale.js", "old");
    expect(await listAll({ Prefix: "alice/" })).toEqual([
      {
        keys: [
          "alice/_naru/queries/a.js",
          "alice/_naru/routes.json",
          "alice/css/a.css",
          "alice/index.html",
          "alice/z.html",
        ],
        prefixes: [],
      },
    ]);
  });

  test("merges folders, once each", async () => {
    // A stale copy from before the move: the folder is listed once.
    buckets.get(SITE)!.set("alice/_naru/queries/a.js", "old");
    expect(await listAll({ Prefix: "alice/", Delimiter: "/" })).toEqual([
      {
        keys: ["alice/index.html", "alice/z.html"],
        prefixes: ["alice/_naru/", "alice/css/"],
      },
    ]);
  });

  test("pages through the site bucket, then the private one", async () => {
    const pages = await listAll({ Prefix: "alice/", MaxKeys: 2 });
    expect(pages.flatMap(({ keys }) => keys).sort()).toEqual([
      "alice/_naru/queries/a.js",
      "alice/_naru/routes.json",
      "alice/css/a.css",
      "alice/index.html",
      "alice/z.html",
    ]);
    expect(pages.length).toBeGreaterThan(1);
  });

  test("lists only the private bucket inside _naru/", async () => {
    buckets.get(SITE)!.set("alice/_naru/queries/stale.js", "old");
    expect(await listAll({ Prefix: "alice/_naru/", MaxKeys: 1 })).toEqual([
      { keys: ["alice/_naru/queries/a.js"], prefixes: [] },
      { keys: ["alice/_naru/routes.json"], prefixes: [] },
    ]);
  });

  test("lists only the site bucket where no site code can be", async () => {
    expect(await listAll({ Prefix: "alice/css/" })).toEqual([
      { keys: ["alice/css/a.css"], prefixes: [] },
    ]);
  });

  test("never shows the private bucket's own files", async () => {
    const all = (await listAll({})).flatMap(({ keys }) => keys);
    expect(all).not.toContain("_naru-runtime/alice/routes.json");
    expect(all).toContain("bob/_naru/queries/b.js");
  });
});

test("signs URLs for site code against the private bucket", async () => {
  const code = await getSignedUrl(
    client,
    new PutObjectCommand({ Bucket: SITE, Key: "alice/_naru/queries/a.js" }),
  );
  const page = await getSignedUrl(
    client,
    new PutObjectCommand({ Bucket: SITE, Key: "alice/index.html" }),
  );
  expect(new URL(code).pathname).toBe(`/${PRIVATE}/alice/_naru/queries/a.js`);
  expect(new URL(page).pathname).toBe(`/${SITE}/alice/index.html`);
});
