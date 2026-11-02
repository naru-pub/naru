import type { Metadata } from "next";
import { MarkdownGuide } from "@/components/GuideFrame";
import { OWNER_DIRECTORY } from "@/lib/board/installs";
import { readGuide, renderGuide } from "@/lib/guide-markdown";
import { codeHtml } from "../Code";
import DocsNav from "../DocsNav";
import { LATEST_VERSION } from "../versions";

// The guide is _guides/templates.md.
const guide = () =>
  readGuide("docs/_guides/templates.md", { owner: OWNER_DIRECTORY });

export function generateMetadata(): Metadata {
  const { pageTitle, description } = guide();
  return { title: pageTitle, description };
}

export default function TemplatesGuide() {
  const rendered = renderGuide(guide(), { code: codeHtml });
  return (
    <MarkdownGuide
      guide={rendered}
      nav={<DocsNav current="templates" version={LATEST_VERSION} />}
      crumb={`NARU / DEVELOPERS / ${rendered.path}`}
      plainCode={false}
    />
  );
}
