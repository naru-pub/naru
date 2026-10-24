// Shared by the board's server code and its client components, so nothing
// here may import server-only modules.

export const POST_KINDS = ["site", "template", "question", "chat"] as const;
export type PostKind = (typeof POST_KINDS)[number];

export const POST_KIND_LABELS: Record<PostKind, string> = {
  site: "사이트 자랑",
  template: "템플릿",
  question: "질문",
  chat: "잡담",
};

export function isPostKind(value: unknown): value is PostKind {
  return (
    typeof value === "string" &&
    (POST_KINDS as readonly string[]).includes(value)
  );
}

export const POST_SORTS = ["activity", "new", "applied"] as const;
export type PostSort = (typeof POST_SORTS)[number];

export const MAX_TITLE_LENGTH = 200;
export const MAX_POST_BODY_LENGTH = 20000;
export const MAX_REPLY_BODY_LENGTH = 5000;
export const MAX_CHANGELOG_LENGTH = 2000;
// Depth 0 is a top-level reply, so replies nest five levels deep. A reply to
// one at the last level becomes its sibling instead.
export const MAX_REPLY_DEPTH = 4;
// A thread page loads at most this many replies; the rest are reached through
// a reply's own page.
export const MAX_THREAD_REPLIES = 500;
export const POSTS_PER_PAGE = 20;

// Templates may be shared only under licenses that let anyone redistribute
// and modify them (free-culture or OSI/FSF-approved). Ids are lowercased SPDX
// identifiers; adding one also needs a migration widening
// board_templates_license_check.
export const LICENSE_KINDS = {
  "public-domain": {
    label: "권리 포기",
    summary:
      "누구나 출처 표시 없이 복사하거나 수정할 수 있고, 상업적으로도 쓸 수 있어요.",
  },
  permissive: {
    label: "출처 표시",
    summary:
      "누구나 복사하거나 수정할 수 있고, 상업적으로도 쓸 수 있어요. 대신 저작권 표시와 라이선스를 함께 남겨야 해요.",
  },
  copyleft: {
    label: "동일 조건 공개",
    summary:
      "누구나 복사하거나 수정할 수 있고, 상업적으로도 쓸 수 있어요. 대신 저작권 표시를 남기고, 고친 결과물도 같은 라이선스로 공개해야 해요.",
  },
} as const;
export type LicenseKind = keyof typeof LICENSE_KINDS;

const spdx = (id: string) => `https://spdx.org/licenses/${id}.html`;

export const LICENSES = {
  "cc0-1.0": {
    name: "CC0 1.0",
    kind: "public-domain",
    url: "https://creativecommons.org/publicdomain/zero/1.0/deed.ko",
  },
  unlicense: {
    name: "Unlicense",
    kind: "public-domain",
    url: spdx("Unlicense"),
  },
  "0bsd": { name: "0BSD", kind: "public-domain", url: spdx("0BSD") },
  "cc-by-4.0": {
    name: "CC BY 4.0",
    kind: "permissive",
    url: "https://creativecommons.org/licenses/by/4.0/deed.ko",
  },
  mit: { name: "MIT", kind: "permissive", url: spdx("MIT") },
  "apache-2.0": {
    name: "Apache 2.0",
    kind: "permissive",
    url: spdx("Apache-2.0"),
  },
  "bsd-2-clause": {
    name: "BSD 2-Clause",
    kind: "permissive",
    url: spdx("BSD-2-Clause"),
  },
  "bsd-3-clause": {
    name: "BSD 3-Clause",
    kind: "permissive",
    url: spdx("BSD-3-Clause"),
  },
  isc: { name: "ISC", kind: "permissive", url: spdx("ISC") },
  zlib: { name: "zlib", kind: "permissive", url: spdx("Zlib") },
  "cc-by-sa-4.0": {
    name: "CC BY-SA 4.0",
    kind: "copyleft",
    url: "https://creativecommons.org/licenses/by-sa/4.0/deed.ko",
  },
  "mpl-2.0": { name: "MPL 2.0", kind: "copyleft", url: spdx("MPL-2.0") },
  "lgpl-3.0-or-later": {
    name: "LGPL 3.0 이상",
    kind: "copyleft",
    url: spdx("LGPL-3.0-or-later"),
  },
  "gpl-2.0-or-later": {
    name: "GPL 2.0 이상",
    kind: "copyleft",
    url: spdx("GPL-2.0-or-later"),
  },
  "gpl-3.0-or-later": {
    name: "GPL 3.0 이상",
    kind: "copyleft",
    url: spdx("GPL-3.0-or-later"),
  },
  "agpl-3.0-or-later": {
    name: "AGPL 3.0 이상",
    kind: "copyleft",
    url: spdx("AGPL-3.0-or-later"),
  },
  "eupl-1.2": { name: "EUPL 1.2", kind: "copyleft", url: spdx("EUPL-1.2") },
  "ofl-1.1": { name: "SIL OFL 1.1", kind: "copyleft", url: spdx("OFL-1.1") },
} as const satisfies Record<
  string,
  { name: string; kind: LicenseKind; url: string }
>;
export type License = keyof typeof LICENSES;

export function isLicense(value: unknown): value is License {
  return typeof value === "string" && Object.hasOwn(LICENSES, value);
}

export const TEMPLATE_SLUG_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_TEMPLATE_SLUG_LENGTH = 64;
// Small enough that publishing and applying stay one request of R2 copies.
export const TEMPLATE_MAX_FILES = 200;
export const TEMPLATE_MAX_BYTES = 20 * 1024 * 1024;
// A workflow publishes a built site, its own code included, which takes more
// files; its uploads skip the files the previous version already had.
export const TEMPLATE_GITHUB_MAX_FILES = 500;
export const TEMPLATE_GITHUB_MAX_BYTES = 50 * 1024 * 1024;

// Where a template's versions come from.
export const TEMPLATE_SOURCES = ["site", "github"] as const;
export type TemplateSource = (typeof TEMPLATE_SOURCES)[number];
export const GITHUB_REPOSITORY_REGEX =
  /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
export const GITHUB_REF_REGEX = /^refs\/(heads|tags)\/[^\s~^:?*[\\]{1,250}$/;

// What a site does when a template it installed publishes a new version.
export const UPDATE_PREFERENCES = ["notify", "auto", "never"] as const;
export type UpdatePreference = (typeof UPDATE_PREFERENCES)[number];
export function isUpdatePreference(value: unknown): value is UpdatePreference {
  return (
    typeof value === "string" &&
    (UPDATE_PREFERENCES as readonly string[]).includes(value)
  );
}

// A template with its own site code (_naru/) installs at the site's root:
// a site has one _naru/.
export const SITE_CODE_PREFIX = "_naru/";
export const hasSiteCode = (paths: readonly string[]) =>
  paths.some((path) => path.startsWith(SITE_CODE_PREFIX));

// Per user, per rolling hour.
export const POSTS_PER_HOUR = 10;
export const REPLIES_PER_HOUR = 60;
export const APPLICATIONS_PER_HOUR = 20;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
