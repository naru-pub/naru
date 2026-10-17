// The Data SDK moved from https://naru.pub/sdk/<version>/ to
// https://sdk.naru.pub/sdk/<version>/, and naru.pub/sdk/ no longer serves it.
// These find and rewrite the old URLs in stored site files
// (maintenance/sdk-url-migration.ts, cli/rewrite-sdk-urls.ts).
//
// Files are handled as bytes, read one byte to one character (latin1), so
// whatever their encoding, BOM or line endings, only the matched ASCII
// changes and everything else is written back exactly as it was.

/**
 * `https://naru.pub/sdk/`, `http://naru.pub/sdk/` or `//naru.pub/sdk/`, the
 * scheme and host in any case, the path exactly. Not when the `//` follows a
 * word character, `:`, `/`, `.` or `-` (another scheme, a port, a longer
 * path, another host such as x.naru.pub), and only with `/sdk/` after the
 * host, so naru.pub/sdkfoo and naru.pub/sdk on its own stay.
 */
const OLD_SDK_URL =
  /(?<![\w:/.-])([hH][tT][tT][pP][sS]?:)?\/\/[nN][aA][rR][uU]\.[pP][uU][bB]\/sdk\//g;

export const NEW_SDK_ORIGIN = "https://sdk.naru.pub";

function replacement(scheme: string | undefined) {
  // http:// goes to https:// too: the new host is served over HTTPS only.
  return scheme ? `${NEW_SDK_ORIGIN}/sdk/` : "//sdk.naru.pub/sdk/";
}

/** Rewrites every old SDK URL prefix in `text`, and counts them. */
export function rewriteSdkUrls(text: string): { text: string; count: number } {
  let count = 0;
  const rewritten = text.replace(OLD_SDK_URL, (_match, scheme?: string) => {
    count += 1;
    return replacement(scheme);
  });
  return { text: rewritten, count };
}

/** The same, on a file's bytes. `body` is null when nothing matched. */
export function rewriteSdkUrlBytes(bytes: Uint8Array): {
  body: Buffer | null;
  count: number;
  snippets: string[];
} {
  const source = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = source.toString("latin1");
  const { text: rewritten, count } = rewriteSdkUrls(text);
  if (count === 0) return { body: null, count, snippets: [] };
  return {
    body: Buffer.from(rewritten, "latin1"),
    count,
    snippets: sdkUrlSnippets(source),
  };
}

/** A few lines of context around the first matches, for the dry run. */
export function sdkUrlSnippets(bytes: Buffer, limit = 3, width = 60): string[] {
  const text = bytes.toString("latin1");
  const snippets: string[] = [];
  for (const match of text.matchAll(OLD_SDK_URL)) {
    if (snippets.length >= limit) break;
    const start = Math.max(0, match.index - width);
    const end = Math.min(text.length, match.index + match[0].length + width);
    snippets.push(
      Buffer.from(text.slice(start, end), "latin1")
        .toString("utf8")
        .replace(/\s+/g, " ")
        .trim(),
    );
  }
  return snippets;
}

// What can hold a script URL: markup, code, styles, data and text.
const TEXT_EXTENSIONS = new Set([
  "html",
  "htm",
  "xhtml",
  "xml",
  "svg",
  "js",
  "mjs",
  "cjs",
  "ts",
  "mts",
  "cts",
  "jsx",
  "tsx",
  "vue",
  "svelte",
  "css",
  "scss",
  "sass",
  "less",
  "json",
  "jsonc",
  "json5",
  "webmanifest",
  "map",
  "md",
  "markdown",
  "mdx",
  "txt",
  "text",
  "csv",
  "tsv",
  "yml",
  "yaml",
  "toml",
  "ini",
  "sql",
  "php",
  "rss",
  "atom",
  "ejs",
  "hbs",
  "njk",
  "liquid",
]);

const TEXT_CONTENT_TYPE =
  /^(text\/|application\/(javascript|ecmascript|json|ld\+json|manifest\+json|xml|xhtml\+xml|rss\+xml|atom\+xml|sql|x-javascript|typescript)|image\/svg\+xml)/i;

/** Whether a stored file is text that could reference the SDK. */
export function isTextFile(path: string, contentType?: string | null) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot > 0 && TEXT_EXTENSIONS.has(name.slice(dot + 1).toLowerCase()))
    return true;
  return !!contentType && TEXT_CONTENT_TYPE.test(contentType);
}

/** Bytes that are not text: a NUL is in no text encoding we rewrite. */
export function looksBinary(bytes: Uint8Array) {
  return bytes.subarray(0, 8192).includes(0);
}

/** The largest file read: the same cap as uploads and the editor. */
export const MAX_REWRITE_BYTES = 10 * 1024 * 1024;
