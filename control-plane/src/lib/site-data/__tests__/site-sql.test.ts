/** @jest-environment node */
import { describe, expect, jest, test } from "@jest/globals";
import { callSiteObject } from "@/lib/edge/client";
import { readSiteDump, restoreSiteDump } from "@/lib/edge/dumps";

// Site SQL (1.1.0) end to end in the site's Durable Object
// (scripts/with-edge-worker.sh): migrations applied with a release, ctx.sql
// in queries and mutations, and the site's tables carried by dump and restore.
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
/** The posts module's queries are these; its other exports are mutations. */
const QUERIES = ["list", "sneak", "naru", "cross"];
const call = (name: string, args: unknown = null, member = "member-1") =>
  callSiteObject<{ result: unknown }>(site, "call", {
    ownerId,
    site,
    member,
    kind: QUERIES.includes(name) ? "query" : "mutation",
    file: "posts",
    name,
    args,
  }).then((answer) => answer.result);

const POST_MUTATIONS = `
export async function add(ctx, { title, board }) {
  const { rows } = await ctx.sql\`INSERT INTO posts (title, board, author) VALUES (\${title}, \${board}, \${ctx.member.id}) RETURNING id\`;
  return rows[0].id;
}
`;
const POST_QUERIES = `
export async function list(ctx, { board }) {
  return (await ctx.sql("SELECT id, title FROM posts WHERE board = ? ORDER BY id", [board])).rows;
}
export async function sneak(ctx) { await ctx.sql\`DELETE FROM posts\`; }
export async function naru(ctx) { return (await ctx.sql\`SELECT * FROM documents\`).rows; }
export async function cross(ctx) {
  return (await ctx.sql\`SELECT count(*) AS n FROM posts a, posts b WHERE a.id > b.id\`).rows;
}
`;
/** Both posts modules, published once. */
const putPosts = async () => {
  await put("mutations", "posts", POST_MUTATIONS, false);
  await put("queries", "posts", POST_QUERIES);
};

integration("site SQL", () => {
  test("a release's migrations make tables that queries and mutations use with ctx.sql", async () => {
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
    await putPosts();
    expect(await call("add", { title: "첫 글", board: "free" })).toBe(1);
    expect(await call("add", { title: "둘째", board: "free" })).toBe(2);
    expect(await call("add", { title: "공지", board: "notice" })).toBe(3);
    expect(await call("list", { board: "free" })).toEqual([
      { id: 1, title: "첫 글" },
      { id: 2, title: "둘째" },
    ]);
    // A query cannot write and Naru's tables cannot be named; a join's
    // shape is not checked (the runtime stops what runs too long).
    await expect(call("sneak")).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/read-only query cannot write/),
    });
    await expect(call("naru")).rejects.toMatchObject({
      message: expect.stringMatching(/documents is Naru's/),
    });
    expect(await call("cross")).toEqual([{ n: 3 }]);
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
    await putPosts();
    expect(await call("list", { board: "notice" })).toEqual([
      { id: 3, title: "공지" },
    ]);
    // Migration SQL is held to the same names as ctx.sql.
    for (const [sql, message] of [
      ["DELETE FROM documents;", /documents is Naru's/],
      ["PRAGMA writable_schema = 1;", /pragmas are Naru's/],
    ] as const) {
      await expect(put("migrations", "0002_bad", sql)).rejects.toMatchObject({
        status: 422,
        message: expect.stringMatching(message),
      });
      await put("migrations", "0002_bad", null, false);
    }
    await putPosts();
  });

  test("a dump carries the site's tables, and restore makes them again", async () => {
    const dump = await readSiteDump(site);
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
    await restoreSiteDump(copy, dump.text);
    const again = await readSiteDump(copy);
    expect(again.site).toEqual(dump.site);
    // A site that has tables is not restored over.
    await expect(restoreSiteDump(copy, dump.text)).rejects.toMatchObject({
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
       export async function whoami(ctx) { return { member: ctx.member, owner: ctx.owner }; }
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
      owner: false,
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
    // A query's file is not a mutation's.
    await expect(
      callSiteObject(site, "call", {
        ownerId,
        site,
        member: "member-2",
        kind: "mutation",
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
      result: { member: null, owner: false },
    });
    const mutation = await atEdge("_mutate/board:write", { title: "x" });
    expect(mutation.status).toBe(401);
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
      // "a" and 19 more fill the connection; the 21st is refused, with no
      // time to retry after: a held count lifts when one is unsubscribed.
      // One at a time: each is counted once it has answered.
      for (let n = 0; n < 20; n++) {
        socket.send(
          JSON.stringify({
            type: "subscribe",
            id: `s${n}`,
            query: "board:count",
            args: null,
          }),
        );
        await until(5 + n);
      }
      const full = heard.slice(4).filter((m) => m.type === "error");
      expect(full).toHaveLength(1);
      expect(full[0]).toEqual({
        type: "error",
        id: "s19",
        error: expect.objectContaining({ status: 429, code: "RATE_LIMITED" }),
      });
      expect(full[0]).not.toHaveProperty("error.retryAfter");
    } finally {
      // An open socket would keep the test run from ending.
      socket.close();
    }
  });
});

integration("routes", () => {
  test("routes.js renders what routes.json routes, as a visitor's query, with its path", async () => {
    await put(
      "root",
      "routes.json",
      JSON.stringify({ version: 1, include: ["/posts/*", "/feed.xml"] }),
      false,
    );
    await put(
      "root",
      "routes.js",
      `export default async function (ctx, { path, origin, query }) {
         if (path === "/feed.xml") {
           const { rows } = await ctx.sql\`SELECT title FROM posts ORDER BY id LIMIT 2\`;
           return { body: \`<rss>\${rows.map((row) => row.title).join(",")}</rss>\`, type: "application/rss+xml" };
         }
         const id = Number(path.split("/")[2]);
         const [post] = (await ctx.sql\`SELECT title FROM posts WHERE id = \${id}\`).rows;
         if (!post) ctx.fail("NOT_FOUND", "그런 글은 없어요.");
         return { html: \`<h1>\${post.title}</h1><p>\${origin ?? ""}\${path} \${query.tab ?? ""} \${ctx.owner}</p>\`, cache: 30 };
       }`,
    );
    const render = (id: string) =>
      callSiteObject<{ result: unknown }>(site, "render", {
        site,
        path: `/posts/${id}`,
        origin: "https://sqlsite.naru.pub",
        query: { tab: "c" },
      });
    expect(await render("1")).toEqual({
      result: {
        html: "<h1>첫 글</h1><p>https://sqlsite.naru.pub/posts/1 c false</p>",
        cache: 30,
      },
    });
    await expect(render("999")).rejects.toMatchObject({
      status: 404,
      message: "그런 글은 없어요.",
    });
    expect(
      await callSiteObject(site, "render", {
        site,
        path: "/feed.xml",
        query: {},
      }),
    ).toEqual({
      result: { body: "<rss>첫 글,둘째</rss>", type: "application/rss+xml" },
    });
    // The release refuses rules that are not _routes.json's, and code
    // without rules.
    for (const [folder, file, source, message] of [
      [
        "root",
        "routes.json",
        '{ "version": 1, "include": [] }',
        /needs a path/,
      ],
      ["root", "routes.json", null, /needs _naru\/routes\.json/],
    ] as const) {
      await expect(put(folder, file, source)).rejects.toMatchObject({
        status: 400,
        message: expect.stringMatching(message),
      });
    }
    await put(
      "root",
      "routes.json",
      JSON.stringify({ version: 1, include: ["/posts/*", "/feed.xml"] }),
    );

    // A site whose paid status has lapsed, or is not confirmed, renders
    // nothing: a 404 with its reason, which the edge answers as a missing
    // path rather than as the mini being away (edge/src/pages.ts).
    const configure = (entitledUntil: number | null, confirmedUntil: number) =>
      callSiteObject(site, "configure", {
        ownerId,
        entitledUntil,
        confirmedUntil,
      });
    try {
      for (const [entitledUntil, confirmedUntil] of [
        [Date.now() - 1000, Date.now() + 60_000],
        [null, Date.now() - 1000],
      ] as const) {
        await configure(entitledUntil, confirmedUntil);
        await expect(render("1")).rejects.toMatchObject({
          status: 404,
          code: "NOT_FOUND",
          details: { reason: "routes_off" },
        });
      }
    } finally {
      await configure(null, Date.now() + 60_000);
    }
    expect(await render("1")).toMatchObject({ result: { cache: 30 } });
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
});

integration("SQLite's refusals", () => {
  test("a value a UNIQUE column holds is a CONFLICT naming it; other mistakes say what SQLite said", async () => {
    await put(
      "migrations",
      "0004_nicks",
      "CREATE TABLE nicks (member TEXT PRIMARY KEY, nick TEXT NOT NULL UNIQUE);",
      false,
    );
    await put(
      "mutations",
      "nicks",
      `export async function claim(ctx, { nick }) {
         await ctx.sql\`INSERT INTO nicks (member, nick) VALUES (\${ctx.member.id}, \${nick})\`;
       }
       export async function typo(ctx) { await ctx.sql\`INSERT INTO nicks (membr) VALUES (1)\`; }`,
    );
    const claim = (member: string, nick: string) =>
      callSiteObject(site, "call", {
        ownerId,
        site,
        member,
        kind: "mutation",
        file: "nicks",
        name: "claim",
        args: { nick },
      });
    await claim("member-1", "아보");
    await expect(claim("member-2", "아보")).rejects.toMatchObject({
      status: 409,
      code: "CONFLICT",
      details: { unique: "nick" },
    });
    await expect(
      callSiteObject(site, "call", {
        ownerId,
        site,
        member: "member-1",
        kind: "mutation",
        file: "nicks",
        name: "typo",
        args: null,
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/SQL failed: .*no column named membr/),
    });
  });
});

integration("AUTOINCREMENT", () => {
  test("a deleted row's id is never handed out again, and dumps carry such tables", async () => {
    await put(
      "migrations",
      "0005_tickets",
      "CREATE TABLE tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, note TEXT NOT NULL);",
      false,
    );
    await put(
      "mutations",
      "tickets",
      `export async function add(ctx, { note }) {
         return (await ctx.sql\`INSERT INTO tickets (note) VALUES (\${note}) RETURNING id\`).rows[0].id;
       }
       export async function remove(ctx, { id }) { await ctx.sql\`DELETE FROM tickets WHERE id = \${id}\`; }`,
    );
    const call = (name: string, args: unknown) =>
      callSiteObject<{ result: unknown }>(site, "call", {
        ownerId,
        site,
        member: "member-1",
        kind: "mutation",
        file: "tickets",
        name,
        args,
      }).then((answer) => answer.result);
    expect(await call("add", { note: "a" })).toBe(1);
    expect(await call("add", { note: "b" })).toBe(2);
    await call("remove", { id: 2 });
    expect(await call("add", { note: "c" })).toBe(3);
    const dump = await readSiteDump(site);
    expect(dump.site.tables.tickets).toHaveLength(2);
    expect(Object.keys(dump.site.tables)).not.toContain("sqlite_sequence");
    const copy = "sqlsite-autoinc";
    await callSiteObject(copy, "erase", {});
    await restoreSiteDump(copy, dump.text);
    expect((await readSiteDump(copy)).site.tables.tickets).toEqual(
      dump.site.tables.tickets,
    );
    await callSiteObject(copy, "erase", {});
  });
});

integration("query limits", () => {
  test("a member's queries are limited as reads are, not as calls", async () => {
    await put("queries", "ping", "export function ping() { return 1; }");
    // More than the 30 calls a minute a member's mutations allow.
    for (let i = 0; i < 130; i++)
      await callSiteObject(site, "call", {
        ownerId,
        site,
        member: "member-9",
        kind: "query",
        file: "ping",
        name: "ping",
        args: null,
      });
  });
});

integration("call limits", () => {
  // The edge Worker's own answer for a site object operation, headers and all.
  const operation = (input: unknown) =>
    fetch(`${process.env.EDGE_WORKER_URL}/v1/sites/${site}/call`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.EDGE_WORKER_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    });
  const bump = (caller: { member?: string; clientIp?: string }) => ({
    ownerId,
    site,
    member: caller.member ?? null,
    ...(caller.member ? {} : { visitor: true, clientIp: caller.clientIp }),
    kind: "mutation",
    file: "limits",
    name: "bump",
    args: null,
  });
  const inMinute = (seconds: unknown) => {
    expect(seconds).toBeGreaterThanOrEqual(1);
    expect(seconds).toBeLessThanOrEqual(60);
  };

  test("members' and visitors' mutation limits say when the minute resets", async () => {
    await put("mutations", "limits", "export function bump() { return 1; }");
    // The buckets are wall-clock minutes: start early in one.
    const into = Date.now() % 60_000;
    if (into > 40_000)
      await new Promise((resolve) => setTimeout(resolve, 60_500 - into));
    // 30 a minute for a member.
    for (let i = 0; i < 30; i++)
      expect((await operation(bump({ member: "member-limit" }))).status).toBe(
        200,
      );
    const member = await operation(bump({ member: "member-limit" }));
    expect(member.status).toBe(429);
    inMinute(Number(member.headers.get("retry-after")));
    const body = (await member.json()) as { error: { retryAfter: number } };
    expect(String(body.error.retryAfter)).toBe(
      member.headers.get("retry-after"),
    );
    // As the control plane's client hands it on.
    const refused = await callSiteObject(
      site,
      "call",
      bump({ member: "member-limit" }),
    ).then(
      () => null,
      (error) => error,
    );
    expect(refused).toMatchObject({ status: 429 });
    inMinute(refused.retryAfter);

    // 20 a minute from one visitor's address.
    for (let i = 0; i < 20; i++)
      expect((await operation(bump({ clientIp: "192.0.2.77" }))).status).toBe(
        200,
      );
    const visitor = await operation(bump({ clientIp: "192.0.2.77" }));
    expect(visitor.status).toBe(429);
    inMinute(Number(visitor.headers.get("retry-after")));

    // A refusal no wait will lift says none.
    const missing = await operation({ ...bump({}), name: "nothing" });
    expect(missing.status).toBeGreaterThanOrEqual(400);
    expect(missing.headers.get("retry-after")).toBeNull();
  }, 60_000);
});

integration("full-text tables", () => {
  test("a trigram table finds Korean text, and dumps carry it", async () => {
    await put(
      "migrations",
      "0006_search",
      "CREATE VIRTUAL TABLE search USING fts5(title, body, tokenize='trigram');",
      false,
    );
    await put(
      "mutations",
      "search",
      `export async function index(ctx, { id, title, body }) {
         await ctx.sql\`INSERT INTO search (rowid, title, body) VALUES (\${id}, \${title}, \${body})\`;
       }`,
      false,
    );
    await put(
      "queries",
      "search",
      `export async function find(ctx, { text }) {
         return (await ctx.sql\`SELECT rowid AS id FROM search WHERE search MATCH \${'"' + text + '"'} ORDER BY rank\`).rows.map((row) => row.id);
       }
       export async function like(ctx, { text }) {
         return (await ctx.sql\`SELECT rowid AS id FROM search WHERE body LIKE \${"%" + text + "%"}\`).rows.map((row) => row.id);
       }`,
    );
    const call = (kind: string, name: string, args: unknown) =>
      callSiteObject<{ result: unknown }>(site, "call", {
        ownerId,
        site,
        member: "member-1",
        kind,
        file: "search",
        name,
        args,
      }).then((answer) => answer.result);
    await call("mutation", "index", {
      id: 10,
      title: "환영",
      body: "아보카도 커뮤니티에 오신 것을 환영합니다",
    });
    await call("mutation", "index", {
      id: 11,
      title: "공지",
      body: "커뮤니티 규칙을 읽어 주세요",
    });
    expect(await call("query", "find", { text: "커뮤니티" })).toEqual(
      expect.arrayContaining([10, 11]),
    );
    expect(await call("query", "find", { text: "아보카도" })).toEqual([10]);
    expect(await call("query", "like", { text: "규칙" })).toEqual([11]);
    // Dumped by its rows, without its own storage tables; restored, it
    // searches as before.
    const dump = await readSiteDump(site);
    expect(dump.site.tables.search).toHaveLength(2);
    expect(Object.keys(dump.site.tables)).not.toContain("search_data");
    expect(dump.site.schema.filter((sql) => /search/.test(sql))).toEqual([
      expect.stringMatching(/^CREATE VIRTUAL TABLE search USING fts5/),
    ]);
    const copy = "sqlsite-fts";
    await callSiteObject(copy, "erase", {});
    await restoreSiteDump(copy, dump.text);
    expect((await readSiteDump(copy)).site.tables.search).toEqual(
      dump.site.tables.search,
    );
    await callSiteObject(copy, "erase", {});
  });
});

integration("BLOB values", () => {
  test("a Uint8Array binds as a BLOB, and a BLOB comes back as one", async () => {
    await put(
      "migrations",
      "0007_blobs",
      "CREATE TABLE blobs (id INTEGER PRIMARY KEY, data BLOB NOT NULL);",
      false,
    );
    await put(
      "mutations",
      "blobs",
      `export async function keep(ctx, { bytes }) {
         const data = new Uint8Array(bytes);
         return (await ctx.sql\`INSERT INTO blobs (data) VALUES (\${data}) RETURNING id\`).rows[0].id;
       }`,
      false,
    );
    await put(
      "queries",
      "blobs",
      `export async function read(ctx, { id }) {
         const [row] = (await ctx.sql\`SELECT data, typeof(data) AS type, length(data) AS size FROM blobs WHERE id = \${id}\`).rows;
         return { isBytes: row.data instanceof Uint8Array, bytes: Array.from(row.data), type: row.type, size: row.size };
       }`,
    );
    const bytes = [0, 1, 2, 250, 255, 128, 64];
    const id = (
      await callSiteObject<{ result: number }>(site, "call", {
        ownerId,
        site,
        member: "member-1",
        kind: "mutation",
        file: "blobs",
        name: "keep",
        args: { bytes },
      })
    ).result;
    expect(
      (
        await callSiteObject<{ result: unknown }>(site, "call", {
          ownerId,
          site,
          member: "member-1",
          kind: "query",
          file: "blobs",
          name: "read",
          args: { id },
        })
      ).result,
    ).toEqual({ isBytes: true, bytes, type: "blob", size: 7 });
  });
});

integration("statement plans", () => {
  test("ordered aggregates, JSON lists and keyset paging run; more than 1,000 rows are refused", async () => {
    await put(
      "migrations",
      "0008_plans",
      `CREATE TABLE chars (id TEXT PRIMARY KEY, name TEXT NOT NULL);
       CREATE TABLE titles (ch TEXT NOT NULL, title TEXT NOT NULL, ord INTEGER NOT NULL);
       CREATE INDEX titles_ch ON titles (ch, ord);
       CREATE TABLE visits (day TEXT PRIMARY KEY, hours TEXT NOT NULL);
       CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL);`,
      false,
    );
    await put(
      "mutations",
      "plans",
      `export async function seed(ctx) {
         await ctx.sql\`INSERT INTO chars (id, name) VALUES ('a', 'A'), ('b', 'B')\`;
         await ctx.sql\`INSERT INTO titles (ch, title, ord) VALUES ('a', 'second', 2), ('a', 'first', 1), ('b', 'only', 1)\`;
         await ctx.sql\`INSERT INTO visits (day, hours) VALUES ('d1', '{"9":2,"10":1}'), ('d2', '{"9":3}')\`;
         for (let start = 1; start <= 1500; start += 100) {
           const ids = Array.from({ length: 100 }, (_, i) => start + i);
           await ctx.sql("INSERT INTO items (id, name) SELECT value, 'item ' || value FROM json_each(?)", [JSON.stringify(ids)]);
         }
       }`,
      false,
    );
    await put(
      "queries",
      "plans",
      `export async function titles(ctx) {
         return (await ctx.sql\`SELECT c.id, (SELECT json_group_array(title) FROM (SELECT title FROM titles WHERE titles.ch = c.id ORDER BY ord)) AS titles FROM chars c ORDER BY c.id\`).rows;
       }
       export async function unindexed(ctx) {
         return (await ctx.sql\`SELECT c.id, (SELECT json_group_array(title) FROM (SELECT title FROM titles WHERE titles.title = c.id ORDER BY ord)) AS titles FROM chars c\`).rows;
       }
       export async function cross(ctx) {
         return (await ctx.sql\`SELECT count(*) AS n FROM items, (SELECT ch, count(*) AS n FROM titles GROUP BY ch)\`).rows;
       }
       export async function hours(ctx) {
         return (await ctx.sql\`SELECT j.key AS hour, sum(j.value) AS n FROM visits, json_each(visits.hours) j GROUP BY j.key ORDER BY j.key\`).rows;
       }
       export async function some(ctx, { ids }) {
         return (await ctx.sql("SELECT count(*) AS n FROM items WHERE id IN (SELECT value FROM json_each(?))", [JSON.stringify(ids)])).rows[0].n;
       }
       export async function all(ctx) {
         return (await ctx.sql\`SELECT id FROM items\`).rows.length;
       }
       export async function page(ctx, { after }) {
         return (await ctx.sql\`SELECT id FROM items WHERE id > \${after} ORDER BY id LIMIT 1000\`).rows.map((row) => row.id);
       }`,
    );
    const call = (kind: string, name: string, args: unknown = null) =>
      callSiteObject<{ result: unknown }>(site, "call", {
        ownerId,
        site,
        member: "member-1",
        kind,
        file: "plans",
        name,
        args,
      }).then((answer) => answer.result);
    await call("mutation", "seed");
    // A correlated subquery's ordered co-routine, found by key.
    expect(await call("query", "titles")).toEqual([
      { id: "a", titles: '["first","second"]' },
      { id: "b", titles: '["only"]' },
    ]);
    // Statements the plan rule once refused run: without an index, a
    // subquery reads all of titles per row, and a cross join pairs every row.
    expect(await call("query", "unindexed")).toEqual([
      { id: "a", titles: "[]" },
      { id: "b", titles: "[]" },
    ]);
    expect(await call("query", "cross")).toEqual([{ n: 3000 }]);
    expect(await call("query", "hours")).toEqual([
      { hour: "10", n: 1 },
      { hour: "9", n: 5 },
    ]);
    const ids = Array.from({ length: 500 }, (_, i) => i * 3 + 1);
    expect(await call("query", "some", { ids })).toBe(500);
    const first = (await call("query", "page", { after: 0 })) as number[];
    expect(first).toHaveLength(1000);
    const next = (await call("query", "page", {
      after: first.at(-1),
    })) as number[];
    expect([next[0], next.at(-1), next.length]).toEqual([1001, 1500, 500]);
    // Without a LIMIT, 1,500 rows are more than a statement returns.
    await expect(call("query", "all")).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/returns at most 1000 rows/),
    });
    // The refused statement was read to its end: nothing stays open to keep
    // a dump from dropping its tables.
    expect((await readSiteDump(site)).text).toContain('"type":"end"');
  });

  test("site SQL reads Naru's view of uploads; ctx has the owner's name", async () => {
    const run = (
      name: string,
      args: unknown = null,
      kind = "query",
      live?: string,
    ) =>
      callSiteObject<{ result: unknown; tables?: string[] }>(site, "call", {
        ownerId,
        site,
        member: "member-1",
        kind,
        file: "extras",
        name,
        args,
        ...(live ? { live } : {}),
      });
    const result = (name: string, args: unknown = null) =>
      run(name, args).then((answer) => answer.result);
    await put(
      "queries",
      "extras",
      `export async function who(ctx) {
         return { owner: ctx.ownerName, member: ctx.member, rolesOf: typeof ctx.rolesOf };
       }
       export async function upload(ctx, { url }) {
         const { rows } = await ctx.sql\`SELECT member, name, type, size FROM _naru_uploads
           WHERE url = \${url}\`;
         return rows[0] ?? null;
       }`,
      false,
    );
    await put(
      "mutations",
      "extras",
      `export async function drop(ctx) { return ctx.sql\`DELETE FROM _naru_uploads\`; }`,
    );
    // Roles are the site's own, in its tables: Naru keeps none.
    expect(await result("who")).toEqual({
      owner: site,
      member: { id: "member-1" },
      rolesOf: "undefined",
    });
    // Uploads as Naru Media recorded them, and forgot them.
    const id = "0190f5a0-0000-7000-8000-00000000f001";
    const url = "https://media.naru.pub/u/a.pdf";
    await callSiteObject(site, "recordMedia", {
      files: [
        {
          id,
          url,
          member: "member-1",
          name: "a.pdf",
          type: "application/pdf",
          size: 2048,
          createdAt: 1,
        },
      ],
    });
    expect(await result("upload", { url })).toEqual({
      member: "member-1",
      name: "a.pdf",
      type: "application/pdf",
      size: 2048,
    });
    // Site SQL writes no view of Naru's.
    await expect(run("drop", null, "mutation")).rejects.toMatchObject({
      status: 400,
    });
    // The library's full list keeps only what it names.
    await callSiteObject(site, "recordMedia", { files: [], keep: [id] });
    expect(await result("upload", { url })).not.toBe(null);
    await callSiteObject(site, "forgetMedia", { ids: [id] });
    expect(await result("upload", { url })).toBe(null);
  });
});
