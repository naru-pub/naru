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
            Body: {
              transformToByteArray: async () => new Uint8Array(object.body),
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
  purgeSiteFiles: async (_: string, paths: string[]) => {
    purged.push(paths);
  },
}));
jest.mock("next/cache", () => ({ revalidatePath: () => {} }));

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
    ).rejects.toThrow("후원 플랜");
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
    expect(first.scope).toBe("read write");
    const grant = await oauth.grantForAccessToken(first.access_token);
    expect(grant).toMatchObject({
      loginName: "mcp-owner",
      scopes: ["read", "write"],
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
      "get_site",
      "list_files",
      "read_file",
    ]);
    await client.close();
  });

  test("works on the site's files like the file manager", async () => {
    const tokens = await connect();
    const client = await mcpClient(tokens.access_token);
    expect((await client.listTools()).tools).toHaveLength(6);

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
