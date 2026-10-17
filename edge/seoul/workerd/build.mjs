// Builds Naru's workerd for the mini: the release of cloudflare/workerd that
// edge/ depends on (package.json's `workerd`), with sqlite-timeout.patch, for
// macOS on Apple silicon. See README.md beside this.
//
//   node seoul/workerd/build.mjs [--revision <n>] [--record]
//
// Writes <cache>/out/workerd-<version>-naru.<n>-darwin-arm64 and its .sha256,
// and checks it with selftest.mjs. <n> is binary.json's revision when that
// names the same workerd version, else 1; give --revision when the patch
// changed. --record writes the build into binary.json, for publishing.
// The cache is NARU_WORKERD_CACHE, or ~/Library/Caches/naru-workerd: the
// source, Bazel's output (about 6.5 GB) and bazelisk. A first build takes
// about 25 minutes on an M4; a rebuild after a patch change, a few.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const edge = join(here, "../..");

// Bazelisk, which fetches the Bazel the workerd release names (.bazelversion).
const BAZELISK = {
  version: "v1.29.0",
  asset: "bazelisk-darwin-arm64",
  sha256: "cee851f726789227d5561004e9904a52be45c3efb56f8b38b6993d6adbaa0409",
};
// The flags of workerd's own macOS release, and Rust's proc-macro dylibs kept
// unstripped: macOS 27's dyld refuses to load the stripped ones the build
// would otherwise make, and the build fails part way.
const BUILD_FLAGS = [
  "--config=release_macos",
  "--@rules_rust//:extra_rustc_flag=-Cstrip=none",
  "--@rules_rust//:extra_exec_rustc_flag=-Cstrip=none",
];

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const fail = (message) => {
  console.error(`build.mjs: ${message}`);
  process.exit(1);
};
const run = (command, argv, options = {}) =>
  execFileSync(command, argv, { stdio: "inherit", ...options });
const sha256 = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

if (process.platform !== "darwin" || process.arch !== "arm64")
  fail("builds for macOS on Apple silicon only, on such a Mac.");

// The workerd edge/ is tested with: package.json pins it exactly, and the
// lockfile must have resolved that version.
const pkg = JSON.parse(await readFile(join(edge, "package.json"), "utf8"));
const version = pkg.devDependencies?.workerd;
if (!/^\d+\.\d{8}\.\d+$/.test(version ?? ""))
  fail(`edge/package.json pins no exact workerd version (${version}).`);
const lock = await readFile(join(edge, "pnpm-lock.yaml"), "utf8");
if (!lock.includes(`\n  workerd@${version}:`))
  fail(`edge/pnpm-lock.yaml has no workerd@${version}; run pnpm install.`);

const recordPath = join(here, "binary.json");
const recorded = existsSync(recordPath)
  ? JSON.parse(await readFile(recordPath, "utf8"))
  : null;
const revision = Number(
  option("--revision") ??
    (recorded?.version === version ? recorded.revision : 1),
);
if (!Number.isInteger(revision) || revision < 1)
  fail("--revision is a whole number from 1.");
const tag = `workerd-v${version}-naru.${revision}`;
const asset = `workerd-${version}-naru.${revision}-darwin-arm64`;

const cache =
  process.env.NARU_WORKERD_CACHE ??
  join(homedir(), "Library/Caches/naru-workerd");
const source = join(cache, `workerd-v${version}`);
const out = join(cache, "out");
await mkdir(out, { recursive: true });

// Bazelisk, checked against its release's digest.
const bazelisk = join(cache, `bazelisk-${BAZELISK.version}`);
if (!existsSync(bazelisk) || (await sha256(bazelisk)) !== BAZELISK.sha256) {
  const url = `https://github.com/bazelbuild/bazelisk/releases/download/${BAZELISK.version}/${BAZELISK.asset}`;
  console.log(`Downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) fail(`${url} answered ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== BAZELISK.sha256)
    fail(`bazelisk's sha256 is ${digest}, not ${BAZELISK.sha256}.`);
  await writeFile(`${bazelisk}.part`, bytes, { mode: 0o755 });
  await rename(`${bazelisk}.part`, bazelisk);
}

// The release's source, as tagged, with only the patch on it.
if (!existsSync(source))
  run("git", [
    "clone",
    "--quiet",
    "--depth",
    "1",
    "--branch",
    `v${version}`,
    "https://github.com/cloudflare/workerd.git",
    source,
  ]);
run("git", ["-C", source, "checkout", "--quiet", "--", "."]);
const patch = join(here, "sqlite-timeout.patch");
try {
  execFileSync("git", ["-C", source, "apply", "--check", patch], {
    stdio: "pipe",
  });
} catch (error) {
  fail(
    `sqlite-timeout.patch does not apply to workerd v${version}:\n${error.stderr}\n` +
      'Port it to this release\'s src/workerd/util/sqlite.c++ (README.md, "Upgrading workerd").',
  );
}
run("git", ["-C", source, "apply", patch]);

const env = {
  ...process.env,
  BAZELISK_HOME: join(cache, "bazelisk-home"),
  // Bazel's own tools want a UTF-8 locale.
  LC_ALL: "en_US.UTF-8",
};
run(
  bazelisk,
  [
    `--output_user_root=${join(cache, "bazel")}`,
    "build",
    ...BUILD_FLAGS,
    "//src/workerd/server:workerd",
  ],
  { cwd: source, env },
);

const binary = join(out, asset);
await copyFile(join(source, "bazel-bin/src/workerd/server/workerd"), binary);
await chmod(binary, 0o755);
const digest = await sha256(binary);
await writeFile(`${binary}.sha256`, `${digest}  ${asset}\n`);
// workerd 1.20261006.1 says it is "workerd 2026-10-06".
const date = version.split(".")[1].replace(/^(\d{4})(\d\d)(\d\d)$/, "$1-$2-$3");
const reported = execFileSync(binary, ["--version"], { encoding: "utf8" });
if (reported.trim() !== `workerd ${date}`)
  fail(`${asset} says it is ${reported.trim()}, not workerd ${date}.`);
run(process.execPath, [join(here, "selftest.mjs"), binary]);

console.log(`\n${binary}\nsha256 ${digest}\ntag    ${tag}`);
if (flag("--record")) {
  await writeFile(
    recordPath,
    `${JSON.stringify({ version, revision, tag, asset, sha256: digest }, null, 2)}\n`,
  );
  console.log(
    `Recorded in ${recordPath}; publish it (README.md, "Publishing").`,
  );
}
