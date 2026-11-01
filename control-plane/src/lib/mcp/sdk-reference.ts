import reference from "@/lib/sdk-reference/1.1.0.json";
import { readGuide, readMarkdown } from "@/lib/guide-markdown";
import { naruOrigin } from "./oauth";

// Naru Data SDK 1.1.0 as Naru MCP's get_sdk_reference gives it to a model:
// what only these tools need (docs/_guides/1.1.0/mcp.md, which no page shows),
// the guides people read on /docs/1.1.0 as they are (database.md and media.md
// beside it, one source for both), the generated reference that /docs/sdk/1.1.0
// draws (scripts/generate-sdk-reference.mjs), then the types of site code,
// functions.d.ts as sites fetch it.

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

/** A guide as Markdown, its site-relative links made absolute. */
function guideText(topic: "database" | "media", site: string) {
  const guide = readGuide(`docs/_guides/1.1.0/${topic}.md`, { site });
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

/** The SDK 1.1.0 guides and reference, for the site `site`. */
export function sdkReference(site: string) {
  return [
    readMarkdown("docs/_guides/1.1.0/mcp.md", {
      site,
      origin: naruOrigin(),
    }).trim(),
    guideText("database", site),
    guideText("media", site),
    "# Reference",
    ...(reference.entries as Entry[]).map(entry),
    "# Site code's types (functions.d.ts)",
    `\`\`\`ts\n${reference.functions.trim()}\n\`\`\``,
  ].join("\n\n");
}
