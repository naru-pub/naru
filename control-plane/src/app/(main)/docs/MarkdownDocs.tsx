import { MarkdownGuide } from "@/components/GuideFrame";
import { readGuide, renderGuide } from "@/lib/guide-markdown";
import { codeHtml } from "./Code";
import DocsNav from "./DocsNav";
import type { DocsVersion } from "./versions";

// An SDK guide written in Markdown, _guides/<version>/<topic>.md, which Naru
// MCP gives models too (lib/mcp/sdk-reference.ts). Its examples name the
// site "example"; MCP fills in the connected site's name.

export const docsGuide = (version: DocsVersion, topic: string) =>
  readGuide(`docs/_guides/${version}/${topic}.md`, { site: "example" });

export function MarkdownDocs({
  version,
  topic,
}: {
  version: DocsVersion;
  topic: string;
}) {
  const guide = renderGuide(docsGuide(version, topic), { code: codeHtml });
  return (
    <MarkdownGuide
      guide={guide}
      nav={<DocsNav current={topic} version={version} />}
      crumb={`NARU / DOCS / ${guide.path}`}
      plainCode={false}
    />
  );
}
