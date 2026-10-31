import reference from "@/lib/sdk-reference/1.0.0.json";
import { SDK_URL } from "@/lib/const";
import { DECLARATION_PATH } from "@/lib/site-data/declared-collections";
import { readGuide } from "@/lib/guide-markdown";
import { naruOrigin } from "./oauth";

// Naru Data SDK 1.0.0 as Naru MCP's get_sdk_reference gives it to a model:
// what only these tools need, the guides people read on /docs/1.0.0 as they
// are (docs/_guides/1.0.0/*.md, one source for both), then the generated
// reference that /docs/sdk/1.0.0 draws (scripts/generate-sdk-reference.mjs).

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

// What only a model building pages through these tools needs; the rest is
// the guide people read.
function preface(site: string) {
  return `# Naru Data SDK 1.0.0

A Naru site's pages store and read JSON documents in the site's own database with this SDK, imported from ${SDK_URL}/1.0.0/naru.js; there is nothing to install or build. The guides below are the ones people read on naru.pub, in Korean, with this site's name, "${site}", in their examples. Links in them are on ${naruOrigin()}.

## Building with these tools

- Always create the client as createNaru({ site: "${site}" }). Without it the SDK finds the site only from a ${site}.naru.pub address, so the page throws on the site's custom domain or a local preview.
- Declare the collections a page needs with configure_collections rather than asking the owner to make them on /database: it writes ${DECLARATION_PATH}, and a new collection is created at once with the access given. A change to an existing collection's access waits for the owner's approval.
- A guestbook: { "guestbook": { "read": "world", "write": "create" } }, a form that add()s { name, message }, and a list sorted by [[{ metadata: "createdAt" }, "desc"]].
- A blog: { "posts": { "read": "world", "write": "admin", "indexes": ["date"] } }, an index page listing posts by date, and a post page that reads ?id= from its address and get()s that post. Only the owner writes posts: through set_document when this connection may write documents, or through an admin page with naru.auth.signIn (section 03 of the database guide).
- Comments: a "comments" collection with "write": "create", each comment naming its post, listed with filter: { postId }.
- Show what visitors wrote with textContent, never innerHTML.
- After saving pages, give the owner the page's address to try it.`;
}

/** A guide as Markdown, its site-relative links made absolute. */
function guideText(topic: "database" | "media", site: string) {
  const guide = readGuide(`docs/_guides/1.0.0/${topic}.md`, { site });
  return [
    `# ${guide.title}`,
    guide.lead,
    ...guide.sections.map(
      ({ title, markdown }) => `## ${title}\n\n${markdown}`,
    ),
  ]
    .join("\n\n")
    .replace(/\]\(\//g, `](${naruOrigin()}/`);
}

/** The SDK 1.0.0 guides and reference, for the site `site`. */
export function sdkReference(site: string) {
  return [
    preface(site),
    guideText("database", site),
    guideText("media", site),
    "# Reference",
    ...(reference.entries as Entry[]).map(entry),
  ].join("\n\n");
}
