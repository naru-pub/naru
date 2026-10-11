/** @jest-environment node */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import { createHmac, generateKeyPairSync } from "node:crypto";

jest.mock("@/lib/cache-purge", () => ({
  purgeSiteFiles: jest.fn(async () => {}),
}));

// Required after the mocks: this transform does not hoist jest.mock above
// imports.
const { sql } = require("kysely") as typeof import("kysely");
const { db } = require("@/lib/database") as typeof import("@/lib/database");
const { s3Client } = require("@/lib/s3") as typeof import("@/lib/s3");
const { github } = require("../githubApp") as typeof import("../githubApp");
const deploys =
  require("../githubAppDeploy") as typeof import("../githubAppDeploy");
const { githubArchive } =
  require("../__fixtures__/archive") as typeof import("../__fixtures__/archive");

// Naru's GitHub App deploys end to end, against the disposable database of
// scripts/test-payments-db.sh. GitHub (github.fetch) and the site bucket
// (s3Client.send) are the boundaries, held in memory here.
const integration =
  process.env.NARU_PAYMENTS_DB_TEST === "1" ? describe : describe.skip;

integration("GitHub App deploys", () => {
  const bucket = new Map<string, Buffer>();
  /** Commits by sha: the archive GitHub would return. */
  const commits = new Map<string, Record<string, string>>();
  let branchHeadSha = "sha-1";
  let duringDownload: (() => Promise<void>) | null = null;
  let userId: string;
  let otherUserId: string;
  const login = "deployer";

  beforeAll(async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    Object.assign(process.env, {
      S3_BUCKET_NAME: "naru-test",
      GITHUB_APP_ID: "1",
      GITHUB_APP_SLUG: "naru",
      GITHUB_APP_CLIENT_ID: "client",
      GITHUB_APP_CLIENT_SECRET: "secret",
      GITHUB_APP_PRIVATE_KEY: Buffer.from(
        privateKey.export({ type: "pkcs1", format: "pem" }),
      ).toString("base64"),
      GITHUB_APP_WEBHOOK_SECRET: "hook",
    });
    const insert = async (name: string) =>
      (
        await sql<{
          id: string;
        }>`insert into users (login_name, password_hash, supporter_comp)
          values (${name}, 'x', true) returning id`.execute(db)
      ).rows[0].id;
    userId = await insert(login);
    otherUserId = await insert("bystander");
    jest.spyOn(s3Client, "send").mockImplementation((async (command: any) => {
      const input = command.input;
      switch (command.constructor.name) {
        case "PutObjectCommand":
          bucket.set(input.Key, Buffer.from(input.Body));
          return {};
        case "HeadObjectCommand":
          return { ContentLength: bucket.get(input.Key)?.byteLength };
        case "GetObjectCommand": {
          const data = bucket.get(input.Key) ?? Buffer.alloc(0);
          return {
            Body: {
              transformToString: async () => data.toString("utf8"),
              transformToByteArray: async () => new Uint8Array(data),
            },
          };
        }
        case "CopyObjectCommand": {
          const source = decodeURIComponent(
            input.CopySource.slice(input.Bucket.length + 1),
          );
          bucket.set(input.Key, bucket.get(source)!);
          return {};
        }
        case "DeleteObjectsCommand":
          for (const { Key } of input.Delete.Objects) bucket.delete(Key);
          return {};
        case "ListObjectsV2Command":
          return {
            Contents: [...bucket]
              .filter(([key]) => key.startsWith(input.Prefix))
              .map(([Key, data]) => ({ Key, Size: data.byteLength })),
          };
      }
      throw new Error(`unexpected ${command.constructor.name}`);
    }) as never);
    github.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/access_tokens"))
        return Response.json({ token: "ghs" });
      if (/\/repositories\/1001$/.test(url))
        return Response.json({ full_name: "owner/site" });
      if (url.includes("/branches/")) {
        if (!url.endsWith("/main")) return new Response("", { status: 404 });
        return Response.json({ commit: { sha: branchHeadSha } });
      }
      const tarball = /\/tarball\/(.+)$/.exec(url);
      if (tarball) {
        const files = commits.get(decodeURIComponent(tarball[1]));
        if (!files) return new Response("", { status: 404 });
        await duringDownload?.();
        return new Response(new Uint8Array(await githubArchive(files)));
      }
      throw new Error(`unexpected GitHub request ${url}`);
    }) as typeof github.fetch;
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    await sql`delete from github_deploy_targets`.execute(db);
    await sql`delete from github_installations`.execute(db);
    await sql`delete from users where id in (${userId}, ${otherUserId})`.execute(
      db,
    );
    await db.destroy();
  });
  beforeEach(() => {
    duringDownload = null;
  });

  const site = (path: string) => bucket.get(`${login}/${path}`)?.toString();
  const target = () =>
    db
      .selectFrom("github_deploy_targets")
      .selectAll()
      .where("user_id", "=", userId)
      .executeTakeFirstOrThrow();
  const link = () =>
    deploys.linkInstallations(userId, [
      { installationId: "77", accountLogin: "owner", repositoryIds: ["1001"] },
    ]);

  test("only a repository the account's GitHub user can read is connected", async () => {
    await link();
    await expect(
      deploys.connectRepository({
        userId,
        installationId: "77",
        repositoryId: "1002",
        branch: "main",
      }),
    ).rejects.toThrow("이 저장소에 접근할 수 없습니다");
    await expect(
      deploys.connectRepository({
        userId: otherUserId,
        installationId: "77",
        repositoryId: "1001",
        branch: "main",
      }),
    ).rejects.toThrow("이 저장소에 접근할 수 없습니다");
    await expect(
      deploys.connectRepository({
        userId,
        installationId: "77",
        repositoryId: "1001",
        branch: "gh-pages",
      }),
    ).rejects.toThrow("브랜치 gh-pages를 찾지 못했습니다");
    for (const branch of ["", "../x", "a b"])
      await expect(
        deploys.connectRepository({
          userId,
          installationId: "77",
          repositoryId: "1001",
          branch,
        }),
      ).rejects.toThrow("브랜치 이름이 올바르지 않습니다");
  });

  test("connecting publishes the branch's current commit, leaving out what a site cannot serve", async () => {
    commits.set("sha-1", {
      "index.html": "<title>첫 사이트</title>",
      "style.css": "body{}",
      "old.html": "old",
      ".github/workflows/deploy.yml": "on: push",
      LICENSE: "MIT",
    });
    await deploys.connectRepository({
      userId,
      installationId: "77",
      repositoryId: "1001",
      branch: "main",
    });
    expect(await target()).toMatchObject({
      pending_sha: "sha-1",
      github_repository: "owner/site",
      github_ref: "refs/heads/main",
    });
    expect(await deploys.runPendingDeploys()).toBe(1);
    expect(site("index.html")).toBe("<title>첫 사이트</title>");
    expect(site("style.css")).toBe("body{}");
    expect(site(".github/workflows/deploy.yml")).toBeUndefined();
    expect(await target()).toMatchObject({
      pending_sha: null,
      deploying_at: null,
      last_error: null,
      last_github_sha: "sha-1",
    });
    const deployment = await db
      .selectFrom("github_deployments")
      .select(["status", "skipped_paths"])
      .where("github_sha", "=", "sha-1")
      .executeTakeFirstOrThrow();
    expect(deployment.status).toBe("finalized");
    expect((deployment.skipped_paths as string[]).sort()).toEqual([
      ".github/workflows/deploy.yml",
      "LICENSE",
    ]);
    const { rows } = await sql<{ site_title: string }>`
      select site_title from users where id = ${userId}`.execute(db);
    expect(rows[0].site_title).toBe("첫 사이트");
  });

  test("a push deploys what changed and removes what is gone", async () => {
    commits.set("sha-2", {
      "index.html": "<title>둘째</title>",
      "style.css": "body{}",
    });
    const puts = () =>
      (s3Client.send as jest.Mock).mock.calls.filter(
        ([command]: any[]) => command.constructor.name === "PutObjectCommand",
      ).length;
    const before = puts();
    // Another branch, another repository: not this target.
    for (const push of [
      { ref: "refs/heads/dev", repositoryId: "1001" },
      { ref: "refs/heads/main", repositoryId: "1002" },
    ])
      expect(
        await deploys.queuePush({
          installationId: "77",
          repository: "owner/site",
          sha: "sha-x",
          ...push,
        }),
      ).toBe(0);
    expect(
      await deploys.queuePush({
        installationId: "77",
        repositoryId: "1001",
        repository: "owner/renamed",
        ref: "refs/heads/main",
        sha: "sha-2",
      }),
    ).toBe(1);
    await deploys.runPendingDeploys();
    expect(puts() - before).toBe(1); // only index.html changed
    expect(site("index.html")).toBe("<title>둘째</title>");
    expect(site("old.html")).toBeUndefined();
    expect(await target()).toMatchObject({
      last_github_sha: "sha-2",
      github_repository: "owner/renamed",
    });
  });

  test("a push that arrives during a deploy is deployed after it", async () => {
    commits.set("sha-3", { "index.html": "three" });
    commits.set("sha-4", { "index.html": "four" });
    await deploys.queuePush({
      installationId: "77",
      repositoryId: "1001",
      repository: "owner/renamed",
      ref: "refs/heads/main",
      sha: "sha-3",
    });
    duringDownload = async () => {
      duringDownload = null;
      await deploys.queuePush({
        installationId: "77",
        repositoryId: "1001",
        repository: "owner/renamed",
        ref: "refs/heads/main",
        sha: "sha-4",
      });
    };
    expect(await deploys.runPendingDeploys()).toBe(2);
    expect(site("index.html")).toBe("four");
    expect(await target()).toMatchObject({
      pending_sha: null,
      last_github_sha: "sha-4",
    });
  });

  test("a failed deploy says why and leaves the site as it was", async () => {
    commits.set("sha-5", { "about.html": "no index" });
    await deploys.queuePush({
      installationId: "77",
      repositoryId: "1001",
      repository: "owner/renamed",
      ref: "refs/heads/main",
      sha: "sha-5",
    });
    expect(await deploys.runPendingDeploys()).toBe(0);
    expect(await target()).toMatchObject({
      pending_sha: null,
      last_error: "index.html이 없습니다.",
      last_github_sha: "sha-4",
    });
    expect(site("index.html")).toBe("four");
    expect(site("about.html")).toBeUndefined();
    // The next good push clears it.
    commits.set("sha-6", { "index.html": "six" });
    await deploys.queuePush({
      installationId: "77",
      repositoryId: "1001",
      repository: "owner/renamed",
      ref: "refs/heads/main",
      sha: "sha-6",
    });
    await deploys.runPendingDeploys();
    expect(await target()).toMatchObject({ last_error: null });
  });

  test("a deploy in progress is left alone, and one that died is taken over", async () => {
    commits.set("sha-7", { "index.html": "seven" });
    await sql`update github_deploy_targets set pending_sha = 'sha-7', pending_at = now(),
      deploying_at = now() where user_id = ${userId}`.execute(db);
    expect(await deploys.runPendingDeploys()).toBe(0);
    await sql`update github_deploy_targets set deploying_at = now() - interval '20 minutes'
      where user_id = ${userId}`.execute(db);
    expect(await deploys.runPendingDeploys()).toBe(1);
    expect(site("index.html")).toBe("seven");
  });

  test("the webhook accepts only GitHub's signed deliveries, and marks the pushed target", async () => {
    const { POST } =
      require("@/app/(main)/api/github/[action]/route") as typeof import("@/app/(main)/api/github/[action]/route");
    commits.set("sha-8", { "index.html": "eight" });
    const body = JSON.stringify({
      ref: "refs/heads/main",
      after: "sha-8",
      deleted: false,
      installation: { id: 77 },
      repository: { id: 1001, full_name: "owner/renamed" },
    });
    const deliver = (signature: string) =>
      POST(
        new Request("https://naru.pub/api/github/webhook", {
          method: "POST",
          headers: {
            "x-github-event": "push",
            "x-hub-signature-256": signature,
          },
          body,
        }),
        { params: Promise.resolve({ action: "webhook" }) },
      );
    expect((await deliver("sha256=forged")).status).toBe(401);
    expect((await target()).pending_sha).toBeNull();
    const signed = `sha256=${createHmac("sha256", "hook").update(body).digest("hex")}`;
    const response = await deliver(signed);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ marked: 1 });
    // Started in the background outside a request; the runner finishes it.
    await deploys.runPendingDeploys();
    for (let n = 0; n < 50 && site("index.html") !== "eight"; n += 1)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(site("index.html")).toBe("eight");
  });

  test("an App target and a workflow never deploy to the same or nested site folders", async () => {
    const { createGitHubDeploymentPlan, upsertGitHubDeployTarget } =
      require("../siteDeploy") as typeof import("../siteDeploy");
    const actions = (prefix: string, user = userId) =>
      upsertGitHubDeployTarget({
        user: { id: user },
        githubRepository: "owner/renamed",
        githubRef: "refs/heads/main",
        targetPrefix: prefix,
      });
    // The App deploys owner/renamed to the site root: a workflow can take
    // neither the root nor a folder inside it.
    await expect(actions("/")).rejects.toThrow("이미 사이트 폴더 /에");
    await expect(actions("docs")).rejects.toThrow("/docs/와 겹칩니다");
    // A workflow of the repository cannot publish over the App's target.
    await expect(
      createGitHubDeploymentPlan({
        claims: {
          iss: "https://token.actions.githubusercontent.com",
          aud: "https://naru.pub",
          sub: "repo:owner/renamed:ref:refs/heads/main",
          exp: 0,
          repository: "owner/renamed",
          repository_id: "1001",
          ref: "refs/heads/main",
          sha: "sha-w",
        },
        site: login,
        targetPrefix: "/",
        manifest: {
          files: [{ path: "index.html", sha256: "a".repeat(64), size: 1 }],
        },
      }),
    ).rejects.toThrow("No enabled GitHub deploy target matches this request");
    // Connecting the same target again is no conflict; another folder is.
    branchHeadSha = "sha-8";
    await expect(
      deploys.connectRepository({
        userId,
        installationId: "77",
        repositoryId: "1001",
        branch: "main",
      }),
    ).resolves.toBeDefined();
    await expect(
      deploys.connectRepository({
        userId,
        installationId: "77",
        repositoryId: "1001",
        branch: "main",
        targetPrefix: "blog",
      }),
    ).rejects.toThrow("겹칩니다");
    // The other way round: a workflow first, then the App on its folder.
    await actions("/", otherUserId);
    await deploys.linkInstallations(otherUserId, [
      { installationId: "77", accountLogin: "owner", repositoryIds: ["1001"] },
    ]);
    await expect(
      deploys.connectRepository({
        userId: otherUserId,
        installationId: "77",
        repositoryId: "1001",
        branch: "main",
      }),
    ).rejects.toThrow(
      "이미 GitHub Actions로 사이트 폴더 /에 배포하고 있습니다",
    );
    // Separate folders are fine.
    await expect(
      deploys.connectRepository({
        userId: otherUserId,
        installationId: "77",
        repositoryId: "1001",
        branch: "main",
        targetPrefix: "mirror",
      }),
    ).rejects.toThrow("겹칩니다"); // still inside the workflow's root
    await sql`update github_deploy_targets set target_prefix = 'app'
      where user_id = ${otherUserId}`.execute(db);
    await expect(
      deploys.connectRepository({
        userId: otherUserId,
        installationId: "77",
        repositoryId: "1001",
        branch: "main",
        targetPrefix: "mirror",
      }),
    ).resolves.toBeDefined();
  });

  test("an uninstalled App or a removed repository stops deploying", async () => {
    await deploys.forgetInstallation("77", ["1001"]);
    expect(await target()).toMatchObject({ enabled: false });
    const { repository_ids } = await db
      .selectFrom("github_installations")
      .select("repository_ids")
      .where("user_id", "=", userId)
      .executeTakeFirstOrThrow();
    expect(repository_ids).toEqual([]);
    expect(
      await deploys.queuePush({
        installationId: "77",
        repositoryId: "1001",
        repository: "owner/renamed",
        ref: "refs/heads/main",
        sha: "sha-9",
      }),
    ).toBe(0);
    await deploys.forgetInstallation("77");
    expect(
      await db
        .selectFrom("github_installations")
        .select("id")
        .where("installation_id", "=", "77")
        .execute(),
    ).toEqual([]);
  });
});
