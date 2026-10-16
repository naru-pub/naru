/** @jest-environment node */
import { describe, expect, jest, test } from "@jest/globals";
import { callSiteObject } from "@/lib/edge/client";

// Site SQL (1.1.0) end to end in the site's Durable Object
// (scripts/with-edge-worker.sh): migrations applied with a release, ctx.sql
// in functions, and the site's tables carried by dump and restore.
const integration =
  process.env.NARU_DATA_TEST === "1" ? describe : describe.skip;

const site = "sqlsite";
const ownerId = "0190f5a0-0000-7000-8000-0000000000aa";
const put = (
  folder: string,
  file: string,
  source: string | null,
  publish = true,
) =>
  callSiteObject(site, "putFunctions", { site, folder, file, source, publish });
const call = (name: string, args: unknown = null, member = "member-1") =>
  callSiteObject<{ result: unknown }>(site, "call", {
    ownerId,
    site,
    member,
    file: "posts",
    name,
    args,
  }).then((answer) => answer.result);

const POSTS = `
export const readOnly = ["list", "sneak", "naru", "cross"];
export async function add(ctx, { title, board }) {
  const { rows } = await ctx.sql\`INSERT INTO posts (title, board, author) VALUES (\${title}, \${board}, \${ctx.member.id}) RETURNING id\`;
  return rows[0].id;
}
export async function list(ctx, { board }) {
  return (await ctx.sql("SELECT id, title FROM posts WHERE board = ? ORDER BY id", [board])).rows;
}
export async function sneak(ctx) { await ctx.sql\`DELETE FROM posts\`; }
export async function naru(ctx) { return (await ctx.sql\`SELECT * FROM documents\`).rows; }
export async function cross(ctx) {
  return (await ctx.sql\`SELECT count(*) AS n FROM posts a, posts b WHERE a.id > b.id\`).rows;
}
`;

integration("site SQL", () => {
  test("a release's migrations make tables that functions use with ctx.sql", async () => {
    await callSiteObject(site, "erase", {});
    await put(
      "migrations",
      "0001_posts",
      `CREATE TABLE posts (
         id INTEGER PRIMARY KEY,
         title TEXT NOT NULL,
         board TEXT NOT NULL,
         author TEXT
       );
       CREATE INDEX posts_board ON posts (board);`,
      false,
    );
    await put("functions", "posts", POSTS);
    expect(await call("add", { title: "첫 글", board: "free" })).toBe(1);
    expect(await call("add", { title: "둘째", board: "free" })).toBe(2);
    expect(await call("add", { title: "공지", board: "notice" })).toBe(3);
    expect(await call("list", { board: "free" })).toEqual([
      { id: 1, title: "첫 글" },
      { id: 2, title: "둘째" },
    ]);
    // A read-only call cannot write, Naru's tables cannot be named, and a
    // statement that would read a table once per row is refused.
    await expect(call("sneak")).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/read-only query cannot write/),
    });
    await expect(call("naru")).rejects.toMatchObject({
      message: expect.stringMatching(/documents is Naru's/),
    });
    await expect(call("cross")).rejects.toMatchObject({
      message: expect.stringMatching(/would search b by a range/),
    });
  });

  test("an applied migration cannot change, and a failing one changes nothing", async () => {
    await expect(
      put(
        "migrations",
        "0001_posts",
        "CREATE TABLE posts (id INTEGER PRIMARY KEY);",
      ),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringMatching(
        /0001_posts\.sql has been applied and cannot be changed/,
      ),
      details: { reason: "migration_failed", migration: "0001_posts.sql" },
    });
    // Put back as applied, then a second migration whose last statement fails.
    await put(
      "migrations",
      "0001_posts",
      `CREATE TABLE posts (
         id INTEGER PRIMARY KEY,
         title TEXT NOT NULL,
         board TEXT NOT NULL,
         author TEXT
       );
       CREATE INDEX posts_board ON posts (board);`,
      false,
    );
    await expect(
      put(
        "migrations",
        "0002_body",
        "ALTER TABLE posts ADD COLUMN body TEXT; INSERT INTO nowhere VALUES (1);",
      ),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringMatching(
        /0002_body\.sql failed: .*no such table: nowhere/,
      ),
    });
    // The ALTER went back with it: the release before still serves.
    await put("migrations", "0002_body", null, false);
    await put("functions", "posts", POSTS);
    expect(await call("list", { board: "notice" })).toEqual([
      { id: 3, title: "공지" },
    ]);
    // Migration SQL is held to the same names and plans as ctx.sql.
    for (const [sql, message] of [
      ["DELETE FROM documents;", /documents is Naru's/],
      ["PRAGMA writable_schema = 1;", /pragmas are Naru's/],
      [
        "UPDATE posts SET author = (SELECT b.title FROM posts b WHERE b.title > posts.title LIMIT 1);",
        /subquery would read all of/,
      ],
    ] as const) {
      await expect(put("migrations", "0002_bad", sql)).rejects.toMatchObject({
        status: 422,
        message: expect.stringMatching(message),
      });
      await put("migrations", "0002_bad", null, false);
    }
    await put("functions", "posts", POSTS);
  });

  test("a dump carries the site's tables, and restore makes them again", async () => {
    const dump = await callSiteObject<{
      site: {
        schema: string[];
        tables: Record<string, unknown[]>;
        migrations: { name: string }[];
      };
    }>(site, "dump", {});
    expect(dump.site.schema).toEqual([
      expect.stringMatching(/^CREATE TABLE posts/),
      "CREATE INDEX posts_board ON posts (board)",
    ]);
    expect(dump.site.tables.posts).toHaveLength(3);
    expect(dump.site.migrations.map((row) => row.name)).toEqual([
      "0001_posts.sql",
    ]);
    const copy = "sqlsite-copy";
    await callSiteObject(copy, "erase", {});
    await callSiteObject(copy, "restore", dump);
    const again = await callSiteObject<typeof dump>(copy, "dump", {});
    expect(again.site).toEqual(dump.site);
    // A site that has tables is not restored over.
    await expect(callSiteObject(copy, "restore", dump)).rejects.toMatchObject({
      status: 409,
    });
    await callSiteObject(copy, "erase", {});
  });
});

integration("queries and mutations", () => {
  const code = (
    kind: "query" | "mutation",
    name: string,
    args: unknown,
    member: string | null = null,
  ) =>
    callSiteObject<{ result: unknown }>(site, "call", {
      ownerId,
      site,
      member,
      ...(member === null ? { visitor: true } : {}),
      kind,
      file: "board",
      name,
      args,
    }).then((answer) => answer.result);

  test("anyone may call them, their code decides, and a query cannot write", async () => {
    await put(
      "queries",
      "board",
      `export async function recent(ctx, { board }) {
         return (await ctx.sql\`SELECT id, title FROM posts WHERE board = \${board} ORDER BY id\`).rows;
       }
       export async function whoami(ctx) { return { member: ctx.member, visitor: ctx.visitor }; }
       export async function sneak(ctx) { await ctx.sql\`DELETE FROM posts\`; }`,
      false,
    );
    await put(
      "mutations",
      "board",
      `export async function write(ctx, { title }) {
         if (!ctx.member) ctx.fail("AUTH_REQUIRED", "회원만 글을 쓸 수 있어요.");
         const { rows } = await ctx.sql\`INSERT INTO posts (title, board, author) VALUES (\${title}, 'free', \${ctx.member.id}) RETURNING id\`;
         return rows[0].id;
       }`,
    );
    expect(await code("query", "whoami", null)).toEqual({
      member: null,
      visitor: true,
    });
    await expect(
      code("mutation", "write", { title: "몰래" }),
    ).rejects.toMatchObject({
      status: 401,
      code: "AUTH_REQUIRED",
    });
    expect(await code("mutation", "write", { title: "넷째" }, "member-2")).toBe(
      4,
    );
    expect(await code("query", "recent", { board: "free" })).toEqual([
      { id: 1, title: "첫 글" },
      { id: 2, title: "둘째" },
      { id: 4, title: "넷째" },
    ]);
    await expect(code("query", "sneak", null)).rejects.toMatchObject({
      message: expect.stringMatching(/read-only query cannot write/),
    });
    // A query or mutation file is not a function, and the other way round.
    await expect(
      callSiteObject(site, "call", {
        ownerId,
        site,
        member: "member-2",
        file: "board",
        name: "recent",
        args: null,
      }),
    ).rejects.toMatchObject({ status: 404 });
    // A visitor's query and mutation at the edge, as browsers reach it.
    await callSiteObject(site, "configure", {
      ownerId,
      entitledUntil: null,
      confirmedUntil: Date.now() + 60_000,
    });
    const atEdge = (path: string, args: unknown) =>
      fetch(`${process.env.EDGE_WORKER_URL}/api/data/v1/${site}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ args }),
      });
    const query = await atEdge("_query/board:whoami", null);
    expect(query.status).toBe(200);
    expect(await query.json()).toMatchObject({
      result: { member: null, visitor: true },
    });
    const mutation = await atEdge("_mutate/board:write", { title: "x" });
    expect(mutation.status).toBe(401);
  });
});

integration("member roles", () => {
  const code = (
    kind: "query" | "mutation",
    name: string,
    args: unknown,
    member: string | null,
  ) =>
    callSiteObject<{ result: unknown }>(site, "call", {
      ownerId,
      site,
      member,
      ...(member === null ? { visitor: true } : {}),
      kind,
      file: "roles",
      name,
      args,
    }).then((answer) => answer.result);

  test("a mutation grants roles, every call reads its caller's, and the owner sets them", async () => {
    await put(
      "queries",
      "roles",
      `export async function me(ctx) { return ctx.member; }
       export async function of(ctx, { ids }) { return ctx.rolesOf(ids); }`,
      false,
    );
    await put(
      "mutations",
      "roles",
      `export async function promote(ctx, { member }) {
         if (!ctx.member?.roles.includes("staff")) ctx.fail("ACCESS_DENIED", "운영진만 할 수 있어요.");
         const now = (await ctx.rolesOf([member]))[member];
         await ctx.setRoles(member, [...now, "writer"]);
       }`,
    );
    expect(await code("query", "me", null, "member-3")).toEqual({
      id: "member-3",
      roles: [],
    });
    await expect(
      code("mutation", "promote", { member: "member-3" }, "member-3"),
    ).rejects.toMatchObject({ status: 403 });
    // The owner, on the control panel.
    expect(
      await callSiteObject(site, "setMemberRoles", {
        member: "member-1",
        roles: ["staff", "staff", "admin"],
      }),
    ).toEqual(["admin", "staff"]);
    await code("mutation", "promote", { member: "member-3" }, "member-1");
    expect(await code("query", "me", null, "member-3")).toEqual({
      id: "member-3",
      roles: ["writer"],
    });
    expect(
      await code(
        "query",
        "of",
        { ids: ["member-1", "member-3", "nobody"] },
        null,
      ),
    ).toEqual({
      "member-1": ["admin", "staff"],
      "member-3": ["writer"],
      nobody: [],
    });
    expect(
      await callSiteObject(site, "rolesOfMembers", { ids: ["member-3"] }),
    ).toEqual({ "member-3": ["writer"] });
    await expect(
      callSiteObject(site, "setMemberRoles", {
        member: "member-3",
        roles: Array.from({ length: 17 }, (_, i) => `r${i}`),
      }),
    ).rejects.toMatchObject({ status: 400 });
    // Dumps carry them.
    const dump = await callSiteObject<{
      site: { roles: { member: string }[] };
    }>(site, "dump", {});
    expect(dump.site.roles.map((row) => row.member).sort()).toEqual([
      "member-1",
      "member-3",
    ]);
  });
});

integration("live queries", () => {
  test("a subscription answers now, and again when a mutation changes what it read", async () => {
    jest.setTimeout?.(30_000);
    await callSiteObject(site, "configure", {
      ownerId,
      entitledUntil: null,
      confirmedUntil: Date.now() + 60_000,
    });
    await put(
      "queries",
      "board",
      `export async function recent(ctx, { board }) {
         return (await ctx.sql\`SELECT title FROM posts WHERE board = \${board} ORDER BY id\`).rows.map((row) => row.title);
       }
       export async function count(ctx) {
         return (await ctx.sql\`SELECT count(*) AS n FROM posts\`).rows[0].n;
       }`,
    );
    const socket = new WebSocket(
      `${process.env.EDGE_WORKER_URL!.replace(/^http/, "ws")}/api/data/v1/${site}/_live`,
    );
    const heard: { type: string; id: string; result?: unknown }[] = [];
    const waiting: (() => void)[] = [];
    socket.onmessage = (event) => {
      heard.push(JSON.parse(String(event.data)));
      waiting.splice(0).forEach((done) => done());
    };
    const until = async (count: number) => {
      const deadline = Date.now() + 5000;
      while (heard.length < count && Date.now() < deadline)
        await new Promise<void>((done) => {
          waiting.push(done);
          setTimeout(done, 100);
        });
      expect(heard.length).toBeGreaterThanOrEqual(count);
    };
    try {
      await new Promise((done, fail) => {
        const timer = setTimeout(
          () => fail(new Error("The live connection did not open.")),
          5000,
        );
        socket.onopen = () => {
          clearTimeout(timer);
          done(null);
        };
        socket.onerror = () => fail(new Error("The live connection failed."));
      });
      socket.send(
        JSON.stringify({
          type: "subscribe",
          id: "a",
          query: "board:recent",
          args: { board: "notice" },
        }),
      );
      socket.send(
        JSON.stringify({
          type: "subscribe",
          id: "b",
          query: "board:count",
          args: null,
        }),
      );
      await until(2);
      const first = Object.fromEntries(heard.map((m) => [m.id, m.result]));
      expect(first.a).toEqual(["공지"]);
      const before = first.b as number;
      // A member's mutation adds to the free board: the count changes, the
      // notice board's answer does not, so only "b" hears.
      await callSiteObject(site, "call", {
        ownerId,
        site,
        member: "member-2",
        kind: "mutation",
        file: "board",
        name: "write",
        args: { title: "다섯째" },
      });
      await until(3);
      expect(heard[2]).toEqual({ type: "result", id: "b", result: before + 1 });
      // Unsubscribed, it hears nothing more.
      socket.send(JSON.stringify({ type: "unsubscribe", id: "b" }));
      await new Promise((done) => setTimeout(done, 100));
      await callSiteObject(site, "call", {
        ownerId,
        site,
        member: "member-2",
        kind: "mutation",
        file: "board",
        name: "write",
        args: { title: "여섯째" },
      });
      await new Promise((done) => setTimeout(done, 300));
      expect(heard).toHaveLength(3);
      // A query that does not exist is an error for that subscription alone.
      socket.send(
        JSON.stringify({
          type: "subscribe",
          id: "c",
          query: "board:nope",
          args: null,
        }),
      );
      await until(4);
      expect(heard[3]).toMatchObject({
        type: "error",
        id: "c",
        error: { status: 404 },
      });
    } finally {
      // An open socket would keep the test run from ending.
      socket.close();
    }
  });
});

integration("routes", () => {
  test("a route renders as a visitor's query, with its path and parameters", async () => {
    await put(
      "routes",
      "posts/_id",
      `export default async function (ctx, { path, params, query }) {
         const [post] = (await ctx.sql\`SELECT title FROM posts WHERE id = \${Number(params.id)}\`).rows;
         if (!post) ctx.fail("NOT_FOUND", "그런 글은 없어요.");
         return { html: \`<h1>\${post.title}</h1><p>\${path} \${query.tab ?? ""} \${ctx.visitor}</p>\`, cache: 30 };
       }`,
    );
    const render = (id: string) =>
      callSiteObject<{ result: unknown }>(site, "render", {
        site,
        route: "posts/_id",
        path: `/posts/${id}`,
        params: { id },
        query: { tab: "c" },
      });
    expect(await render("1")).toEqual({
      result: { html: "<h1>첫 글</h1><p>/posts/1 c true</p>", cache: 30 },
    });
    await expect(render("999")).rejects.toMatchObject({
      status: 404,
      message: "그런 글은 없어요.",
    });
    // A route with a dot in its name, answering text of its own type.
    await put(
      "routes",
      "feed.xml",
      `export default async function (ctx) {
         const { rows } = await ctx.sql\`SELECT title FROM posts ORDER BY id LIMIT 2\`;
         return { body: \`<rss>\${rows.map((row) => row.title).join(",")}</rss>\`, type: "application/rss+xml" };
       }`,
    );
    expect(
      await callSiteObject(site, "render", {
        site,
        route: "feed.xml",
        path: "/feed.xml",
        params: {},
        query: {},
      }),
    ).toEqual({
      result: { body: "<rss>첫 글,둘째</rss>", type: "application/rss+xml" },
    });
  });
});

integration("guest passwords and uploads in tables", () => {
  const code = (kind: "query" | "mutation", name: string, args: unknown) =>
    callSiteObject<{ result: unknown }>(site, "call", {
      ownerId,
      site,
      member: null,
      visitor: true,
      clientIp: "203.0.113.9",
      kind,
      file: "guest",
      name,
      args,
    }).then((answer) => answer.result);

  test("a mutation keeps a guest's password hash; a query checks it, ten wrong tries an hour", async () => {
    await put(
      "migrations",
      "0003_guest",
      "CREATE TABLE guest_posts (id INTEGER PRIMARY KEY, body TEXT NOT NULL, password TEXT NOT NULL);",
      false,
    );
    await put(
      "queries",
      "guest",
      `export async function open(ctx, { id, password }) {
         const [post] = (await ctx.sql\`SELECT body, password FROM guest_posts WHERE id = \${id}\`).rows;
         if (!(await ctx.passwords.verify(password, post.password, \`post:\${id}\`)))
           ctx.fail("ACCESS_DENIED", "비밀번호가 달라요.");
         return post.body;
       }
       export async function sneak(ctx) { return typeof ctx.passwords.hash; }`,
      false,
    );
    await put(
      "mutations",
      "guest",
      `export async function write(ctx, { body, password }) {
         const hash = await ctx.passwords.hash(password);
         return (await ctx.sql\`INSERT INTO guest_posts (body, password) VALUES (\${body}, \${hash}) RETURNING id\`).rows[0].id;
       }`,
    );
    const id = await code("mutation", "write", {
      body: "비밀글",
      password: "1234",
    });
    expect(await code("query", "open", { id, password: "1234" })).toBe(
      "비밀글",
    );
    // A query can check a password but not make one.
    expect(await code("query", "sneak", null)).toBe("undefined");
    for (let i = 0; i < 10; i++)
      await expect(
        code("query", "open", { id, password: "0000" }),
      ).rejects.toMatchObject({ status: 403 });
    await expect(
      code("query", "open", { id, password: "1234" }),
    ).rejects.toMatchObject({ status: 429, code: "RATE_LIMITED" });
  });

  test("an upload named in a table counts as used", async () => {
    const used = "0190f5a0-0000-7000-8000-00000000abcd";
    const unused = "0190f5a0-0000-7000-8000-00000000dcba";
    await put(
      "mutations",
      "guest",
      `export async function image(ctx, { url }) {
         await ctx.sql\`INSERT INTO guest_posts (body, password) VALUES (\${url}, 'x')\`;
       }`,
    );
    await code("mutation", "image", {
      url: `https://media.naru.pub/${ownerId}/${used}.png`,
    });
    expect(
      await callSiteObject(site, "mediaReferences", { ids: [used, unused] }),
    ).toEqual([used]);
  });
});
