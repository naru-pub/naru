import { createHmac, createSign, timingSafeEqual } from "node:crypto";

// Naru's GitHub App, which deploys a repository on push without a workflow
// (docs/github-app.md). This is the App's side of GitHub: its own token, an
// installation's token, a user's OAuth token, the webhook signature, and the
// few API calls a deploy needs. Every request goes through `github.fetch`, so
// tests stand in for GitHub there.

export const github = {
  fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
};

const API = "https://api.github.com";
/** A repository archive larger than this is refused before it is unpacked. */
export const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;

export class GitHubError extends Error {}

export function githubAppConfig() {
  const {
    GITHUB_APP_ID: appId,
    GITHUB_APP_SLUG: slug,
    GITHUB_APP_CLIENT_ID: clientId,
    GITHUB_APP_CLIENT_SECRET: clientSecret,
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_APP_WEBHOOK_SECRET: webhookSecret,
  } = process.env;
  if (
    !appId ||
    !slug ||
    !clientId ||
    !clientSecret ||
    !privateKey ||
    !webhookSecret
  )
    return null;
  return {
    appId,
    slug,
    clientId,
    clientSecret,
    // Kept base64-encoded in the environment, which holds one line per value.
    privateKey: Buffer.from(privateKey, "base64").toString("utf8"),
    webhookSecret,
  };
}

function config() {
  const found = githubAppConfig();
  if (!found) throw new GitHubError("Naru's GitHub App is not configured.");
  return found;
}

const base64url = (value: string | Buffer) =>
  Buffer.from(value).toString("base64url");

/** The App's own short-lived JWT, which only asks for installation tokens. */
export function appJwt(now = Date.now()) {
  const { appId, privateKey } = config();
  const seconds = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // A minute back, for clock drift; GitHub refuses more than ten ahead.
  const payload = base64url(
    JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: appId }),
  );
  const signature = createSign("RSA-SHA256")
    .update(`${header}.${payload}`)
    .sign(privateKey);
  return `${header}.${payload}.${base64url(signature)}`;
}

/** Whether a webhook delivery is GitHub's, by its X-Hub-Signature-256. */
export function verifyWebhookSignature(body: string, signature: string | null) {
  const { webhookSecret } = config();
  if (!signature?.startsWith("sha256=")) return false;
  const expected = Buffer.from(
    `sha256=${createHmac("sha256", webhookSecret).update(body).digest("hex")}`,
  );
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function call<T>(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await github.fetch(
    path.startsWith("https://") ? path : `${API}${path}`,
    {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "naru.pub",
        ...init.headers,
      },
      signal: init.signal ?? AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok)
    throw new GitHubError(
      `GitHub answered ${response.status} to ${init.method ?? "GET"} ${path}.`,
    );
  return response.json() as Promise<T>;
}

/** Every page of a GitHub list, up to `pages` of 100. */
async function all<T>(
  path: string,
  token: string,
  key: string,
  pages = 10,
): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; page <= pages; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const result = await call<Record<string, T[]>>(
      `${path}${separator}per_page=100&page=${page}`,
      token,
    );
    items.push(...(result[key] ?? []));
    if ((result[key] ?? []).length < 100) break;
  }
  return items;
}

/**
 * A token for one installation, limited to reading `repositoryId` when given:
 * a deploy can read the repository it deploys and nothing else.
 */
export async function installationToken(
  installationId: string,
  repositoryId?: string,
) {
  const result = await call<{ token: string }>(
    `/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    appJwt(),
    {
      method: "POST",
      body: JSON.stringify({
        permissions: { contents: "read", metadata: "read" },
        ...(repositoryId ? { repository_ids: [Number(repositoryId)] } : {}),
      }),
    },
  );
  return result.token;
}

/** The OAuth code GitHub returned with the person who installed or signed in. */
export async function userToken(code: string) {
  const { clientId, clientSecret } = config();
  const response = await github.fetch(
    "https://github.com/login/oauth/access_token",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  const result = (await response.json().catch(() => ({}))) as {
    access_token?: string;
  };
  if (!response.ok || !result.access_token)
    throw new GitHubError("GitHub did not accept the sign-in.");
  return result.access_token;
}

export type UserInstallation = {
  installationId: string;
  accountLogin: string;
  repositoryIds: string[];
};

/**
 * The App's installations this GitHub user can reach, each with only the
 * repositories in it the user can read.
 */
export async function userInstallations(
  token: string,
): Promise<UserInstallation[]> {
  const installations = await all<{ id: number; account: { login: string } }>(
    "/user/installations",
    token,
    "installations",
  );
  return Promise.all(
    installations.map(async (installation) => ({
      installationId: String(installation.id),
      accountLogin: installation.account.login,
      repositoryIds: (
        await all<{ id: number }>(
          `/user/installations/${installation.id}/repositories`,
          token,
          "repositories",
        )
      ).map((repository) => String(repository.id)),
    })),
  );
}

export type Repository = {
  id: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
};

/** The repositories an installation holds. */
export async function installationRepositories(
  installationId: string,
): Promise<Repository[]> {
  const repositories = await all<{
    id: number;
    full_name: string;
    default_branch: string;
    private: boolean;
  }>(
    "/installation/repositories",
    await installationToken(installationId),
    "repositories",
  );
  return repositories.map((repository) => ({
    id: String(repository.id),
    fullName: repository.full_name,
    defaultBranch: repository.default_branch,
    private: repository.private,
  }));
}

/** A repository, by id, and the commit its branch is at now. */
export async function branchHead(
  token: string,
  repositoryId: string,
  branch: string,
) {
  const repository = await call<{ full_name: string }>(
    `/repositories/${encodeURIComponent(repositoryId)}`,
    token,
  );
  const head = await call<{ commit: { sha: string } }>(
    `/repositories/${encodeURIComponent(repositoryId)}/branches/${encodeURIComponent(branch)}`,
    token,
  );
  return { fullName: repository.full_name, sha: head.commit.sha };
}

/** One commit of a repository as a gzipped tar, read whole, size-capped. */
export async function downloadArchive(
  token: string,
  repositoryId: string,
  sha: string,
): Promise<Buffer> {
  const response = await github.fetch(
    `${API}/repositories/${encodeURIComponent(repositoryId)}/tarball/${encodeURIComponent(sha)}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "naru.pub",
      },
      signal: AbortSignal.timeout(120_000),
    },
  );
  if (!response.ok || !response.body)
    throw new GitHubError(
      `GitHub answered ${response.status} to the archive of ${sha}.`,
    );
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_ARCHIVE_BYTES) {
      await reader.cancel();
      throw new GitHubError("The repository is larger than 100 MB.");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
