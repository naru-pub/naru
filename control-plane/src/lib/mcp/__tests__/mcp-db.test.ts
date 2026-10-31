/**
 * @jest-environment node
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import { createHash } from "node:crypto";

process.env.NEXT_PUBLIC_DOMAIN = "naru.test";
process.env.S3_BUCKET_NAME = "site";
process.env.SITE_DATA_CONTROL_PLANE_ORIGIN = "https://naru.test";

// The site bucket, in memory: what the file tools' commands need of R2.
const objects = new Map<string, { body: Buffer; type?: string; at: Date }>();
const notFound = () =>
  Object.assign(new Error("Not found"), { name: "NotFound" });
jest.mock("@/lib/s3", () => ({
  s3Client: {
    send: async (command: { constructor: { name: string }; input: any }) => {
      const input = command.input;
      switch (command.constructor.name) {
        case "HeadObjectCommand": {
          const object = objects.get(input.Key);
          if (!object) throw notFound();
          return {
            ContentLength: object.body.length,
            ContentType: object.type,
          };
        }
        case "GetObjectCommand": {
          const object = objects.get(input.Key);
          if (!object) throw notFound();
          return {
            ContentLength: object.body.length,
            Body: {
              transformToByteArray: async () => new Uint8Array(object.body),
              transformToString: async () => object.body.toString("utf8"),
            },
          };
        }
        case "PutObjectCommand":
          objects.set(input.Key, {
            body: Buffer.from(input.Body),
            type: input.ContentType,
            at: new Date(),
          });
          return {};
        case "DeleteObjectCommand":
          objects.delete(input.Key);
          return {};
        case "CopyObjectCommand": {
          const source = decodeURIComponent(
            input.CopySource.slice(input.CopySource.indexOf("/") + 1),
          );
          const object = objects.get(source);
          if (!object) throw notFound();
          objects.set(input.Key, { ...object, at: new Date() });
          return {};
        }
        case "ListObjectsV2Command":
          return {
            Contents: [...objects]
              .filter(([key]) => key.startsWith(input.Prefix))
              .sort(([a], [b]) => (a < b ? -1 : 1))
              .map(([Key, object]) => ({
                Key,
                Size: object.body.length,
                LastModified: object.at,
              })),
            IsTruncated: false,
          };
      }
      throw new Error(`unexpected ${command.constructor.name}`);
    },
  },
}));
const purged: string[][] = [];
jest.mock("@/lib/cache-purge", () => ({
  // As the real purge, installs a saved declaration.
  purgeSiteFiles: async (site: string, paths: string[]) => {
    purged.push(paths);
    if (paths.includes("_naru/collections.json"))
      await (
        jest.requireActual(
          "@/lib/site-data/declared-collections",
        ) as typeof import("@/lib/site-data/declared-collections")
      ).installDeclaredCollections(site);
  },
}));
jest.mock("next/cache", () => ({ revalidatePath: () => {} }));
// The site's database object, in memory: one collection's documents, and
// what the database tools asked of it.
const stored = new Map<string, { data: unknown; version: number }>();
const collectionRows = new Map<
  string,
  { name: string; read_access: string; write_access: string }
>();
const executed: any[] = [];
jest.mock("@/lib/edge/client", () => ({
  ...(jest.requireActual("@/lib/edge/client") as object),
  callSiteObject: async (_site: string, operation: string, input: any) => {
    if (operation === "collections")
      return [...collectionRows.values()].filter(
        (row) => !input.names || input.names.includes(row.name),
      );
    if (operation === "configureCollections") {
      const created = input.collections
        .map((c: { name: string }) => c.name)
        .filter((name: string) => !collectionRows.has(name));
      for (const c of input.collections)
        collectionRows.set(c.name, {
          name: c.name,
          read_access: c.read_access,
          write_access: c.write_access,
        });
      return created;
    }
    if (operation !== "execute") throw new Error(`unexpected ${operation}`);
    executed.push(input);
    const { path, method, body, ifVersion } = input;
    const at = "2026-10-31T00:00:00.000Z";
    const documentOf = (id: string) => ({
      id,
      data: stored.get(id)!.data,
      version: stored.get(id)!.version,
      createdAt: at,
      updatedAt: at,
    });
    if (!path.length)
      return { result: { collections: [...collectionRows.values()] } };
    if (method === "GET" && path.length === 2) {
      if (!stored.has(path[1])) {
        const { DataError } = jest.requireActual(
          "@/lib/site-data/validation",
        ) as typeof import("@/lib/site-data/validation");
        throw new DataError(404, "Document not found.");
      }
      return { result: { document: documentOf(path[1]) } };
    }
    if (method === "GET")
      return {
        result: {
          documents: [...stored.keys()].map(documentOf),
          nextCursor: null,
        },
      };
    if (method === "DELETE") {
      stored.delete(path[1]);
      return { result: { success: true } };
    }
    const id = path[1] ?? "new-id";
    if (
      ifVersion !== undefined &&
      ifVersion !== (stored.get(id)?.version ?? 0)
    ) {
      const { DataError } = jest.requireActual(
        "@/lib/site-data/validation",
      ) as typeof import("@/lib/site-data/validation");
      throw new DataError(409, "Revision mismatch.", "CONFLICT");
    }
    stored.set(id, {
      data: body.data,
      version: (stored.get(id)?.version ?? 0) + 1,
    });
    const { data: _, ...written } = documentOf(id);
    return { result: written };
  },
}));
// Apps' Client ID Metadata Documents, by URL, instead of the network.
const documents = new Map<string, unknown>();
const fetched: string[] = [];
jest.mock("../client-metadata", () => ({
  ...(jest.requireActual("../client-metadata") as object),
  fetchMetadataDocument: async (url: string) => {
    fetched.push(url);
    if (!documents.has(url))
      throw new Error("The client metadata answered 404.");
    return documents.get(url);
  },
}));

// Required after the mocks: this transform does not hoist jest.mock above imports.
const { sql } = require("kysely") as typeof import("kysely");
const { db } = require("@/lib/database") as typeof import("@/lib/database");
const oauth = require("../oauth") as typeof import("../oauth");
const route =
  require("@/app/(main)/mcp/route") as typeof import("@/app/(main)/mcp/route");
const { Client } =
  require("@modelcontextprotocol/sdk/client/index.js") as typeof import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } =
  require("@modelcontextprotocol/sdk/client/streamableHttp.js") as typeof import("@modelcontextprotocol/sdk/client/streamableHttp.js");

// Runs against the disposable database of scripts/test-payments-db.sh.
const integration =
  process.env.NARU_PAYMENTS_DB_TEST === "1" ? describe : describe.skip;

const s256 = (value: string) =>
  createHash("sha256").update(value).digest("base64url");
const verifier = "v".repeat(43);
const redirectUri = "https://app.example/callback";

integration("Naru MCP", () => {
  let owner: string;
  let lapsed: string;
  const ids: string[] = [];

  beforeAll(async () => {
    const insert = async (name: string, comp: boolean) => {
      const id = (
        await sql<{
          id: string;
        }>`insert into users (login_name, password_hash, supporter_comp)
          values (${name}, 'x', ${comp}) returning id`.execute(db)
      ).rows[0].id;
      ids.push(String(id));
      return String(id);
    };
    owner = await insert("mcp-owner", true);
    lapsed = await insert("mcp-lapsed", false);
  });

  afterAll(async () => {
    await sql`delete from users where id in (${sql.join(ids)})`.execute(db);
    await db.deleteFrom("mcp_clients").execute();
    await db.destroy();
  });

  const register = () =>
    oauth.registerClient({
      client_name: "Test app",
      redirect_uris: [redirectUri],
    });

  async function code(userId: string, scope?: string) {
    const client = await register();
    const input = await oauth.authorizeRequest({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: s256(verifier),
      code_challenge_method: "S256",
      state: "the state",
      resource: "https://naru.test/mcp",
      ...(scope ? { scope } : {}),
    });
    const back = new URL(
      await oauth.approveAuthorization(userId, input, input.scopes),
    );
    expect(back.origin + back.pathname).toBe(redirectUri);
    expect(back.searchParams.get("state")).toBe("the state");
    expect(back.searchParams.get("iss")).toBe("https://naru.test");
    return { clientId: client.client_id, code: back.searchParams.get("code")! };
  }

  const exchange = (fields: Record<string, string>) =>
    oauth.exchangeToken(new URLSearchParams(fields));

  async function connect(userId = owner, scope?: string) {
    const { clientId, code: issued } = await code(userId, scope);
    const tokens = await exchange({
      grant_type: "authorization_code",
      client_id: clientId,
      code: issued,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    });
    return { clientId, ...tokens };
  }

  test("registers only redirects a page may be sent to", async () => {
    for (const uri of [
      "javascript:alert(1)",
      "data:text/html,hi",
      "http://app.example/callback",
      "https://app.example/callback#x",
    ])
      await expect(
        oauth.registerClient({ redirect_uris: [uri] }),
      ).rejects.toMatchObject({ error: "invalid_redirect_uri" });
    const client = await oauth.registerClient({
      redirect_uris: [
        "http://127.0.0.1:33418/callback",
        "cursor://anysphere.cursor-mcp/oauth/callback",
        redirectUri,
      ],
    });
    expect(client.token_endpoint_auth_method).toBe("none");
    expect(client.client_name).toBe("MCP 앱");
  });

  test("refuses a sign-in to an unregistered redirect or another resource", async () => {
    const client = await register();
    const base = {
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: s256(verifier),
      code_challenge_method: "S256",
    };
    await expect(
      oauth.authorizeRequest({
        ...base,
        redirect_uri: "https://evil.example/",
      }),
    ).rejects.toBeInstanceOf(oauth.ConsentError);
    await expect(
      oauth.authorizeRequest({ ...base, resource: "https://evil.example/mcp" }),
    ).rejects.toBeInstanceOf(oauth.ConsentError);
    await expect(
      oauth.authorizeRequest({ ...base, scope: "admin" }),
    ).rejects.toBeInstanceOf(oauth.ConsentError);
  });

  test("doesn't approve an account without the plan", async () => {
    const client = await register();
    const input = await oauth.authorizeRequest({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: s256(verifier),
      code_challenge_method: "S256",
    });
    await expect(
      oauth.approveAuthorization(lapsed, input, ["read"]),
    ).rejects.toThrow("서포터 기능");
  });

  test("spends a code on a wrong verifier", async () => {
    const { clientId, code: issued } = await code(owner);
    const fields = {
      grant_type: "authorization_code",
      client_id: clientId,
      code: issued,
      redirect_uri: redirectUri,
    };
    await expect(
      exchange({ ...fields, code_verifier: "w".repeat(43) }),
    ).rejects.toMatchObject({ error: "invalid_grant" });
    await expect(
      exchange({ ...fields, code_verifier: verifier }),
    ).rejects.toMatchObject({ error: "invalid_grant" });
  });

  test("rotates tokens, and ends the connection when a replaced refresh token returns", async () => {
    const first = await connect();
    expect(first.scope).toBe("read write database");
    const grant = await oauth.grantForAccessToken(first.access_token);
    expect(grant).toMatchObject({
      loginName: "mcp-owner",
      scopes: ["read", "write", "database"],
    });

    const second = await exchange({
      grant_type: "refresh_token",
      client_id: first.clientId,
      refresh_token: first.refresh_token,
    });
    expect(await oauth.grantForAccessToken(first.access_token)).toBeNull();
    expect(await oauth.grantForAccessToken(second.access_token)).not.toBeNull();

    // Another app's client_id can't use it.
    const other = await register();
    await expect(
      exchange({
        grant_type: "refresh_token",
        client_id: other.client_id,
        refresh_token: second.refresh_token,
      }),
    ).rejects.toMatchObject({ error: "invalid_grant" });

    // The first refresh token again: someone else holds it.
    await expect(
      exchange({
        grant_type: "refresh_token",
        client_id: first.clientId,
        refresh_token: first.refresh_token,
      }),
    ).rejects.toMatchObject({ error: "invalid_grant" });
    expect(await oauth.grantForAccessToken(second.access_token)).toBeNull();
    await expect(
      exchange({
        grant_type: "refresh_token",
        client_id: first.clientId,
        refresh_token: second.refresh_token,
      }),
    ).rejects.toMatchObject({ error: "invalid_grant" });
  });

  test("matches a loopback redirect on any port, and nothing else loosely", async () => {
    const client = await oauth.registerClient({
      redirect_uris: ["http://127.0.0.1/callback", "https://app.example/cb"],
    });
    const ask = (redirect_uri: string) =>
      oauth.authorizeRequest({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri,
        code_challenge: s256(verifier),
        code_challenge_method: "S256",
      });
    await expect(ask("http://127.0.0.1:53682/callback")).resolves.toMatchObject(
      {
        redirectUri: "http://127.0.0.1:53682/callback",
      },
    );
    for (const uri of [
      "http://localhost:53682/callback",
      "http://127.0.0.1:53682/other",
      "https://app.example:8443/cb",
    ])
      await expect(ask(uri)).rejects.toBeInstanceOf(oauth.ConsentError);
  });

  test("signs in an app by its Client ID Metadata Document", async () => {
    const url = "https://claude.ai/oauth/claude-code-client-metadata";
    documents.set(url, {
      client_id: url,
      client_name: "Claude Code",
      redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
      token_endpoint_auth_method: "none",
    });
    const before = fetched.length;
    const ask = () =>
      oauth.authorizeRequest({
        response_type: "code",
        client_id: url,
        redirect_uri: "http://localhost:41234/callback",
        code_challenge: s256(verifier),
        code_challenge_method: "S256",
        resource: "https://naru.test/mcp",
      });
    const input = await ask();
    expect(input.client).toMatchObject({
      name: "Claude Code",
      identity: "claude.ai",
    });
    // Read once, then kept for a day.
    await ask();
    expect(fetched.length - before).toBe(1);

    const code = new URL(
      await oauth.approveAuthorization(owner, input, ["read"]),
    ).searchParams.get("code")!;
    const tokens = await exchange({
      grant_type: "authorization_code",
      client_id: url,
      code,
      code_verifier: verifier,
      redirect_uri: "http://localhost:41234/callback",
    });
    expect(tokens.scope).toBe("read");
    const refreshed = await exchange({
      grant_type: "refresh_token",
      client_id: url,
      refresh_token: tokens.refresh_token,
    });
    expect(
      await oauth.grantForAccessToken(refreshed.access_token),
    ).toMatchObject({
      scopes: ["read"],
    });
    expect(
      (await oauth.listGrants(owner)).find((g) => g.name === "Claude Code"),
    ).toMatchObject({ host: "claude.ai" });
  });

  test("refuses a metadata document that isn't the app's own", async () => {
    const url = "https://evil.example/client.json";
    documents.set(url, {
      client_id: "https://claude.ai/oauth/claude-code-client-metadata",
      client_name: "Claude Code",
      redirect_uris: ["https://evil.example/cb"],
    });
    const ask = (client_id: string) =>
      oauth.authorizeRequest({
        response_type: "code",
        client_id,
        redirect_uri: "https://evil.example/cb",
        code_challenge: s256(verifier),
        code_challenge_method: "S256",
      });
    await expect(ask(url)).rejects.toThrow("client_id");
    await expect(ask("https://gone.example/client.json")).rejects.toThrow(
      "읽지 못했습니다",
    );
    await expect(ask("http://claude.ai/client.json")).rejects.toThrow(
      "등록되지 않은 앱",
    );
  });

  test("revokes a connection from /account", async () => {
    const tokens = await connect();
    const grant = (await oauth.grantForAccessToken(tokens.access_token))!;
    const listed = await oauth.listGrants(owner);
    expect(listed.find((g) => g.id === grant.grantId)).toMatchObject({
      name: "Test app",
      host: "app.example",
    });
    await oauth.revokeGrant(lapsed, grant.grantId);
    expect(await oauth.grantForAccessToken(tokens.access_token)).not.toBeNull();
    await oauth.revokeGrant(owner, grant.grantId);
    expect(await oauth.grantForAccessToken(tokens.access_token)).toBeNull();
  });

  // An MCP client talking to app/(main)/mcp/route.ts, as an app would.
  async function mcpClient(token: string) {
    const client = new Client({ name: "test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL("https://naru.test/mcp"),
      {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
        fetch: async (url, init) => {
          const request = new Request(url, init);
          return request.method === "POST" ? route.POST(request) : route.GET();
        },
      },
    );
    await client.connect(transport);
    return client;
  }

  const textOf = (result: any) => result.content[0].text as string;

  test("asks an app without a token to sign in", async () => {
    const response = await route.POST(
      new Request("https://naru.test/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://naru.test/.well-known/oauth-protected-resource/mcp"',
    );
  });

  test("offers a read-only connection only the reading tools", async () => {
    const tokens = await connect(owner, "read");
    const client = await mcpClient(tokens.access_token);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_sdk_reference",
      "get_site",
      "list_collections",
      "list_files",
      "read_file",
    ]);
    await client.close();
  });

  test("works on the site's files like the file manager", async () => {
    const tokens = await connect();
    const client = await mcpClient(tokens.access_token);
    expect((await client.listTools()).tools).toHaveLength(13);

    const written = await client.callTool({
      name: "write_file",
      arguments: {
        path: "/index.html",
        content: "<title>MCP 홈</title><h1>안녕</h1>",
      },
    });
    expect(written.isError).toBeFalsy();
    expect(JSON.parse(textOf(written))).toMatchObject({
      path: "index.html",
      created: true,
      url: "http://mcp-owner.naru.test/index.html",
    });
    expect(objects.has("mcp-owner/index.html")).toBe(true);
    expect(purged).toContainEqual(["index.html"]);
    const row = await db
      .selectFrom("users")
      .select("site_title")
      .where("id", "=", owner)
      .executeTakeFirstOrThrow();
    expect(row.site_title).toBe("MCP 홈");

    const read = await client.callTool({
      name: "read_file",
      arguments: { path: "index.html" },
    });
    expect(textOf(read)).toBe("<title>MCP 홈</title><h1>안녕</h1>");

    await client.callTool({
      name: "write_file",
      arguments: {
        path: "img/dot.png",
        content: Buffer.from("png bytes").toString("base64"),
        encoding: "base64",
      },
    });
    const image = (await client.callTool({
      name: "read_file",
      arguments: { path: "img/dot.png" },
    })) as any;
    expect(image.content[0]).toMatchObject({
      type: "image",
      mimeType: "image/png",
    });

    const moved = await client.callTool({
      name: "move_file",
      arguments: { from: "img/dot.png", to: "img/점.png" },
    });
    expect(moved.isError).toBeFalsy();
    const listed = JSON.parse(
      textOf(await client.callTool({ name: "list_files", arguments: {} })),
    );
    expect(listed.files.map((f: { path: string }) => f.path)).toEqual([
      "img/점.png",
      "index.html",
    ]);

    for (const [name, args, message] of [
      ["delete_file", { path: "index.html" }, "can't be deleted"],
      [
        "write_file",
        { path: "run.php", content: "<?php" },
        "does not host .php",
      ],
      ["read_file", { path: "../other/index.html" }, "traversal"],
      ["delete_file", { path: "gone.html" }, "does not exist"],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(message);
    }

    const deleted = await client.callTool({
      name: "delete_file",
      arguments: { path: "img/점.png" },
    });
    expect(deleted.isError).toBeFalsy();
    expect(objects.has("mcp-owner/img/점.png")).toBe(false);
    await client.close();
  });

  test("explains SDK 1.0.0 to the model", async () => {
    const tokens = await connect(owner, "read");
    const client = await mcpClient(tokens.access_token);
    const reference = textOf(
      await client.callTool({ name: "get_sdk_reference", arguments: {} }),
    );
    expect(reference).toContain("https://sdk.naru.pub/sdk/1.0.0/naru.js");
    expect(reference).toContain("_naru/collections.json");
    expect(reference).toContain("interface AdminCollection");
    await client.close();
  });

  test("offers the database's reading tools to a read-only database connection", async () => {
    const tokens = await connect(owner, "read database");
    const client = await mcpClient(tokens.access_token);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_document",
      "get_sdk_reference",
      "get_site",
      "list_collections",
      "list_documents",
      "list_files",
      "read_file",
    ]);
    await client.close();
  });

  test("creates collections at once, and leaves widening to the owner", async () => {
    collectionRows.clear();
    objects.set("mcp-owner/_naru/collections.json", {
      body: Buffer.from(
        JSON.stringify({
          collections: { settings: { read: "admin", write: "admin" } },
        }),
      ),
      at: new Date(),
    });
    const tokens = await connect(owner, "read write");
    const client = await mcpClient(tokens.access_token);

    const configured = await client.callTool({
      name: "configure_collections",
      arguments: {
        collections: { guestbook: { read: "admin", write: "create" } },
      },
    });
    expect(configured.isError).toBeFalsy();
    expect(JSON.parse(textOf(configured))).toEqual({
      created: ["settings", "guestbook"],
      notCreated: [],
      waitingForOwner: [],
    });
    expect(
      JSON.parse(
        objects.get("mcp-owner/_naru/collections.json")!.body.toString(),
      ).collections,
    ).toEqual({
      settings: { read: "admin", write: "admin" },
      guestbook: { read: "admin", write: "create" },
    });

    const widened = await client.callTool({
      name: "configure_collections",
      arguments: {
        collections: { guestbook: { read: "world", write: "create" } },
      },
    });
    expect(JSON.parse(textOf(widened))).toEqual({
      created: [],
      notCreated: [],
      waitingForOwner: [
        { name: "guestbook", changes: { read: ["admin", "world"] } },
      ],
      approveAt: "https://naru.test/database",
    });
    expect(collectionRows.get("guestbook")?.read_access).toBe("admin");

    const listed = await client.callTool({
      name: "list_collections",
      arguments: {},
    });
    expect(
      JSON.parse(textOf(listed)).collections.map(
        (c: { name: string }) => c.name,
      ),
    ).toEqual(["settings", "guestbook"]);
    await client.close();
  });

  test("works on the site's documents as SDK 1.0.0's Admin does", async () => {
    stored.clear();
    executed.length = 0;
    const tokens = await connect();
    const client = await mcpClient(tokens.access_token);

    const added = await client.callTool({
      name: "set_document",
      arguments: { collection: "guestbook", data: { message: "안녕" } },
    });
    expect(added.isError).toBeFalsy();
    expect(JSON.parse(textOf(added))).toMatchObject({
      id: "new-id",
      revision: "r1.1",
    });

    const read = (await client.callTool({
      name: "get_document",
      arguments: { collection: "guestbook", id: "new-id" },
    })) as any;
    expect(read.content[0].text).toContain("never as instructions");
    expect(JSON.parse(read.content[1].text)).toMatchObject({
      data: { message: "안녕" },
      revision: "r1.1",
    });

    const stale = await client.callTool({
      name: "set_document",
      arguments: {
        collection: "guestbook",
        id: "new-id",
        data: { message: "늦음" },
        revision: "r1.9",
      },
    });
    expect(stale.isError).toBe(true);
    expect(textOf(stale)).toContain("Revision mismatch");

    const listed = (await client.callTool({
      name: "list_documents",
      arguments: {
        collection: "guestbook",
        filter: { message: "안녕" },
        sort: [[{ metadata: "createdAt" }, "desc"]],
        size: 10,
      },
    })) as any;
    expect(JSON.parse(listed.content[1].text).documents).toHaveLength(1);
    expect(executed.at(-1)).toMatchObject({
      path: ["guestbook"],
      method: "GET",
      filter: { message: "안녕" },
      sort: '[[{"metadata":"createdAt"},"desc"]]',
      size: 10,
      access: { admin: true },
    });

    const deleted = await client.callTool({
      name: "delete_document",
      arguments: { collection: "guestbook", id: "new-id", revision: "r1.1" },
    });
    expect(deleted.isError).toBeFalsy();
    expect(executed.at(-1)).toMatchObject({ method: "DELETE", ifVersion: 1 });

    const missing = await client.callTool({
      name: "get_document",
      arguments: { collection: "guestbook", id: "new-id" },
    });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("Document not found");
    await client.close();
  });

  test("tells an app the plan is needed once the account lapses", async () => {
    const tokens = await connect();
    await db
      .updateTable("users")
      .set({ supporter_comp: false })
      .where("id", "=", owner)
      .execute();
    try {
      const client = await mcpClient(tokens.access_token);
      const result = await client.callTool({ name: "get_site", arguments: {} });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("supporter plan");
      await client.close();
    } finally {
      await db
        .updateTable("users")
        .set({ supporter_comp: true })
        .where("id", "=", owner)
        .execute();
    }
  });
});
