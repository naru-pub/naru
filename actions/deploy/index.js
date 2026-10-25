const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const FILE_EXTENSION_MIMETYPE_MAP = {
  html: "text/html",
  htm: "text/html",
  xml: "application/xml",
  xhtml: "application/xhtml+xml",
  svg: "image/svg+xml",
  md: "text/markdown",
  markdown: "text/markdown",
  mdx: "text/markdown",
  css: "text/css",
  txt: "text/plain",
  js: "application/javascript",
  mjs: "application/javascript",
  json: "application/json",
  // Site code's migrations (_naru/migrations/*.sql).
  sql: "application/sql",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  ogg: "audio/ogg",
  wav: "audio/wav",
  mp3: "audio/mpeg",
  opus: "audio/opus",
  mid: "audio/midi",
  midi: "audio/midi",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
};

const ALLOWED_FILE_EXTENSIONS = new Set(
  Object.keys(FILE_EXTENSION_MIMETYPE_MAP),
);

function getInput(name, options = {}) {
  const key = `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
  const value = process.env[key]?.trim() ?? "";
  if (options.required && !value) {
    throw new Error(`Missing required input: ${name}`);
  }
  return value || options.defaultValue || "";
}

function getBooleanInput(name, defaultValue) {
  const value = getInput(name, { defaultValue: String(defaultValue) });
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function info(message) {
  console.log(message);
}

function setOutput(name, value) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  return fs.appendFile(output, `${name}=${value}\n`);
}

function appendStepSummary(markdown) {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (!summary) return;
  return fs.appendFile(summary, markdown);
}

function setFailed(error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`::error::${message}`);
  process.exitCode = 1;
}

function normalizeEndpoint(endpoint) {
  const url = new URL(endpoint);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url;
}

function apiUrl(endpoint, pathname) {
  const url = new URL(endpoint.toString());
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${pathname}`;
  return url.toString();
}

function normalizeRelativePath(filePath) {
  const normalized = filePath.split(path.sep).join("/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("//")) {
    throw new Error(`Invalid deploy path: ${filePath}`);
  }
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error(`Path traversal detected: ${filePath}`);
  }

  const extension = normalized.split(".").pop()?.toLowerCase();
  if (!extension || !ALLOWED_FILE_EXTENSIONS.has(extension)) {
    throw new Error(`Unsupported file extension: ${normalized}`);
  }

  return normalized;
}

async function collectFiles(rootDir, currentDir = rootDir) {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(rootDir, absolutePath)));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }

    const relativePath = normalizeRelativePath(
      path.relative(rootDir, absolutePath),
    );
    const contents = await fs.readFile(absolutePath);
    const extension = relativePath.split(".").pop().toLowerCase();

    files.push({
      absolutePath,
      path: relativePath,
      sha256: crypto.createHash("sha256").update(contents).digest("hex"),
      size: contents.byteLength,
      contentType: FILE_EXTENSION_MIMETYPE_MAP[extension],
    });
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

async function getOidcToken(audience) {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) {
    throw new Error(
      "GitHub OIDC is unavailable. Set workflow permissions: id-token: write.",
    );
  }

  const url = new URL(requestUrl);
  url.searchParams.set("audience", audience);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${requestToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to request GitHub OIDC token: ${response.status}`);
  }

  const body = await response.json();
  if (!body.value) {
    throw new Error("GitHub OIDC token response did not include a token");
  }
  return body.value;
}

async function postJson(url, token, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {
      message: text
        ? `${response.status} ${response.statusText}: ${text.slice(0, 300)}`
        : `${response.status} ${response.statusText}`,
    };
  }

  if (!response.ok || data.success === false) {
    throw new Error(
      data.message || `Request failed: ${response.status} ${url}`,
    );
  }

  return data;
}

async function uploadFile(upload, file) {
  const contents = await fs.readFile(file.absolutePath);
  const response = await fetch(upload.url, {
    method: upload.method || "PUT",
    headers: upload.headers || {},
    body: contents,
  });

  if (!response.ok) {
    throw new Error(
      `Failed to upload ${file.path}: ${response.status} ${response.statusText}`,
    );
  }
}

async function uploadFiles(uploads, fileByPath, concurrency = 4) {
  let index = 0;

  async function worker() {
    while (index < uploads.length) {
      const upload = uploads[index++];
      const file = fileByPath.get(upload.path);
      if (!file) {
        throw new Error(`Plan requested an unknown file: ${upload.path}`);
      }
      await uploadFile(upload, file);
    }
  }

  const workerCount = Math.min(concurrency, uploads.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

// Finalize publishes the files and answers before the site's code (its
// queries, mutations, routes and migrations) is active: activation can take
// minutes. Wait for it, so a release the site refuses fails the workflow.
const FUNCTIONS_TIMEOUT_MS = 15 * 60 * 1000;
const FUNCTIONS_POLL_MS = 5000;

async function waitForFunctions(endpoint, audience, deploymentId) {
  const deadline = Date.now() + FUNCTIONS_TIMEOUT_MS;
  for (;;) {
    const status = await postJson(
      apiUrl(endpoint, "/api/deploy/github/status"),
      await getOidcToken(audience),
      { deploymentId },
    );
    const functions = status.functions;
    if (!functions || functions.status === "active") return;
    if (functions.status === "refused") {
      const details = functions.error?.details;
      throw new Error(
        `Naru refused the site's code: ${functions.error?.message ?? "unknown error"}${
          details ? ` ${JSON.stringify(details)}` : ""
        }. The files are published; the previous code stays active.`,
      );
    }
    if (Date.now() > deadline) {
      throw new Error(
        "The site's code is still activating after 15 minutes; Naru keeps trying.",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, FUNCTIONS_POLL_MS));
  }
}

// `dir` as a folder of the repository, which a template's post names.
function repositoryFolder(rootDir) {
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  return path.relative(workspace, rootDir).split(path.sep).join("/");
}

// The pushed commit's message, for a template version's changelog.
async function commitMessage() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) return null;
  try {
    const event = JSON.parse(await fs.readFile(eventPath, "utf8"));
    return event.head_commit?.message ?? null;
  } catch {
    return null;
  }
}

async function main() {
  const templateOwner = getInput("template-owner");
  const templateId = getInput("template");
  const template = templateId || templateOwner;
  const site = template ? "" : getInput("site", { required: true });
  const dir = getInput("dir", { required: true });
  const targetPrefix = getInput("target", { defaultValue: "/" });
  const endpoint = normalizeEndpoint(
    getInput("endpoint", { defaultValue: "https://naru.pub" }),
  );
  const audience = getInput("audience", { defaultValue: endpoint.origin });
  const shouldFinalize = getBooleanInput("finalize", true);
  const rootDir = path.resolve(process.cwd(), dir);

  let rootDirectory;
  try {
    rootDirectory = await fs.stat(rootDir);
  } catch {
    throw new Error(`Deploy directory does not exist: ${dir}`);
  }
  if (!rootDirectory.isDirectory()) {
    throw new Error(`Deploy path is not a directory: ${dir}`);
  }

  const files = await collectFiles(rootDir);
  if (!template && !files.some((file) => file.path === "index.html")) {
    throw new Error("Deploy directory must include index.html");
  }

  info(
    template
      ? `Planning the template's next version with ${files.length} file(s)`
      : `Planning Naru deploy for ${site} with ${files.length} file(s)`,
  );

  const token = await getOidcToken(audience);
  const plan = await postJson(
    apiUrl(endpoint, "/api/deploy/github/plan"),
    token,
    {
      ...(template
        ? {
            ...(templateId
              ? { template: templateId }
              : { templateOwner, folder: repositoryFolder(rootDir) }),
            changelog: await commitMessage(),
          }
        : { site, targetPrefix }),
      manifest: {
        files: files.map(({ absolutePath, ...file }) => file),
      },
    },
  );

  if (plan.skipped) {
    // The template's post does not exist yet; the first run after it does
    // publishes its first version.
    info(plan.message);
    await appendStepSummary(`## No Naru template yet\n\n${plan.message}.\n`);
    return;
  }

  await setOutput("deployment-id", plan.deploymentId);
  info(`Uploading ${plan.uploads.length} staged file(s)`);

  const fileByPath = new Map(files.map((file) => [file.path, file]));
  await uploadFiles(plan.uploads, fileByPath);

  if (!shouldFinalize) {
    info(`Uploaded staged files for deployment ${plan.deploymentId}`);
    return;
  }

  info(`Finalizing deployment ${plan.deploymentId}`);
  const finalizeToken = await getOidcToken(audience);
  const finalize = await postJson(
    apiUrl(endpoint, "/api/deploy/github/finalize"),
    finalizeToken,
    {
      deploymentId: plan.deploymentId,
    },
  );

  if (finalize.functions?.status === "activating") {
    info("Activating the site's code");
    await waitForFunctions(endpoint, audience, plan.deploymentId);
  }

  if (template) {
    await setOutput("deployed-files", finalize.deployedFiles ?? "");
    await setOutput("uploaded-files", finalize.uploadedFiles ?? "");
    await appendStepSummary(`## Naru template version published

| | |
| --- | --- |
| Template | \`${templateId || `${templateOwner}: ${repositoryFolder(rootDir) || "/"}`}\` |
| Version | v${finalize.version}${finalize.unchanged ? " (unchanged, no new version)" : ""} |
| Commit | \`${process.env.GITHUB_SHA || "unknown"}\` |
| Files | ${finalize.deployedFiles ?? 0} (${finalize.uploadedFiles ?? 0} uploaded) |
`);
    info(
      finalize.unchanged
        ? `Unchanged since v${finalize.version}: no new version`
        : `Published v${finalize.version}: ${finalize.deployedFiles} file(s), ${finalize.uploadedFiles} uploaded`,
    );
    return;
  }

  await setOutput("deployed-files", finalize.deployedFiles ?? "");
  await setOutput("uploaded-files", finalize.uploadedFiles ?? "");
  await setOutput("deleted-files", finalize.deletedFiles ?? "");
  await setOutput("directory-size", finalize.directorySize ?? "");
  const siteUrl = `${endpoint.protocol}//${site}.${endpoint.host}/`;
  await setOutput("site-url", siteUrl);
  await appendStepSummary(`## Naru deployment complete

| | |
| --- | --- |
| Site | [${siteUrl}](${siteUrl}) |
| Commit | \`${process.env.GITHUB_SHA || "unknown"}\` |
| Deployed files | ${finalize.deployedFiles ?? 0} |
| Uploaded files | ${finalize.uploadedFiles ?? 0} |
| Deleted files | ${finalize.deletedFiles ?? 0} |
| Directory size | ${finalize.directorySize ?? 0} bytes |
| Deployment ID | \`${plan.deploymentId}\` |
`);
  info(
    `Deployed ${finalize.deployedFiles} file(s), uploaded ${finalize.uploadedFiles} changed file(s), deleted ${finalize.deletedFiles} file(s)`,
  );
}

main().catch(setFailed);
