import type { Metadata } from "next";
import { MarkdownGuide } from "@/components/GuideFrame";
import { readGuide, renderGuide } from "@/lib/guide-markdown";
import { codeHtml } from "../Code";
import DocsNav from "../DocsNav";
import { LATEST_VERSION } from "../versions";

// The guide is _guides/dev.md. It is about the @naru-pub/dev package, not one
// SDK version, so it has no versions.
const guide = () => readGuide("docs/_guides/dev.md");

const { pageTitle, description } = guide();
export const metadata: Metadata = { title: pageTitle, description };

export default function DevGuide() {
  const rendered = renderGuide(guide(), { code: codeHtml });
  return (
    <MarkdownGuide
      guide={rendered}
      nav={<DocsNav current="dev" version={LATEST_VERSION} />}
      crumb={`NARU / DOCS / ${rendered.path}`}
      plainCode={false}
    />
  );
}
