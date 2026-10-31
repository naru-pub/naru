import reference from "@/lib/sdk-reference/1.0.0.json";
import { SDK_URL } from "@/lib/const";
import { DECLARATION_PATH } from "@/lib/site-data/declared-collections";
import { naruOrigin } from "./oauth";

// Naru Data SDK 1.0.0 as Naru MCP's get_sdk_reference gives it to a model:
// how a page loads and uses it, then the generated reference that
// /docs/sdk/1.0.0 draws (scripts/generate-sdk-reference.mjs), as Markdown.

type Span = { type: string; value: string };
type Block =
  | { type: "paragraph"; spans: Span[] }
  | { type: "code"; language: string; code: string };
type Member = { signature: string; summary: Block[] };
type Entry = {
  name: string;
  kind: string;
  signature: string;
  summary: Block[];
  members?: Member[];
};

const blocks = (value: Block[]) =>
  value
    .map((block) =>
      block.type === "paragraph"
        ? block.spans.map((span) => span.value).join("")
        : `\`\`\`${block.language}\n${block.code}\n\`\`\``,
    )
    .join("\n\n");

function entry({ name, kind, signature, summary, members }: Entry) {
  const parts = [`### ${name} (${kind})`, `\`\`\`ts\n${signature}\n\`\`\``];
  if (summary.length) parts.push(blocks(summary));
  for (const member of members ?? []) {
    parts.push(`\`\`\`ts\n${member.signature}\n\`\`\``);
    if (member.summary.length) parts.push(blocks(member.summary));
  }
  return parts.join("\n\n");
}

function guide(site: string) {
  return `# Naru Data SDK 1.0.0

A Naru site's pages store and read JSON documents in the site's own database. A page imports the SDK from Naru; there is nothing to install or build:

\`\`\`html
<script type="module">
  import { createNaru } from "${SDK_URL}/1.0.0/naru.js";
  const naru = createNaru();
  const { documents } = await naru.collection("posts").list();
</script>
\`\`\`

On the site's own pages createNaru() needs no options; elsewhere pass { site: "${site}" }.

## Collections

A collection holds documents: an id and one JSON value (at most 64 KiB). Collection names and document ids are 1–64 letters, digits, _ or -. Each collection says who may read and write it:

- read "admin": only the signed-in owner; "world": anyone, with get, list, count and pages.
- write "admin": only the signed-in owner; "create": anyone may add new documents (a guestbook) but not change them; "world": anyone may set and delete any document (rarely wanted).

A site declares the collections its pages need in ${DECLARATION_PATH}, which the configure_collections tool writes. Naru creates the missing ones at once, with the access declared; a change to an existing collection's access waits for the owner's approval on ${naruOrigin()}/database:

\`\`\`json
{
  "collections": {
    "guestbook": { "read": "world", "write": "create" },
    "settings": { "read": "admin", "write": "admin" }
  }
}
\`\`\`

Each collection also takes optional "unique" and "indexes", lists of field names.

## The owner's sign-in

naru.auth.signIn({ collections }) sends the site's owner to Naru to sign in, and naru.auth.session() on the page they return to gives an Admin client that reads and writes those collections whatever their access. The owner first lists the admin page's address and its collections under 웹사이트 관리자 로그인 on ${naruOrigin()}/database.

## Writes and conflicts

set(id, data) replaces the whole document. Pass { condition: { revision } } to write only if it hasn't changed since it was read, or { condition: { absent: true } } to write only a new one; otherwise the write fails with NaruError code CONFLICT. admin.batch() commits up to 100 sets and deletes across collections, all or none.

## Lists

filter compares top-level fields by value or with { gt, gte, lt, lte }, at most 5 conditions, all of which must hold. sort is one or two [field, "asc" | "desc"] pairs, where a field is a name or { metadata: "createdAt" }; the default is by id. Pages hold up to 100 documents; follow nextCursor with after.

## Building with these tools

A guestbook: configure_collections with { "guestbook": { "read": "world", "write": "create" } }, then a page whose form calls naru.collection("guestbook").add({ name, message, at: new Date().toISOString() }) and lists the entries with list({ sort: [[{ metadata: "createdAt" }, "desc"]] }). Visitors can add entries but not change or delete them. Show what visitors wrote with textContent, never innerHTML.

A blog: configure_collections with { "posts": { "read": "world", "write": "admin", "indexes": ["date"] } }, then an index page that lists posts sorted by date and a post page that reads ?id= from its address and get()s that post. Only the owner writes posts: through set_document when this connection may write documents, or through an admin page with naru.auth.signIn({ collections: ["posts"] }), whose address the owner lists on ${naruOrigin()}/database.

Comments on posts work like a guestbook: one "comments" collection with "write": "create", each comment naming its post, listed with filter: { post: id }.

After saving pages, give the owner the page's address to try it.

## Reference
`;
}

/** The SDK 1.0.0 guide and reference, for the site `site`. */
export function sdkReference(site: string) {
  return [
    guide(site),
    ...(reference.entries as Entry[]).map(entry),
    `Documented in full, in Korean, at ${naruOrigin()}/docs/1.0.0/database and ${naruOrigin()}/docs/sdk/1.0.0.`,
  ].join("\n\n");
}
