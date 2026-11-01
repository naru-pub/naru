import type { Metadata } from "next";
import { docsGuide, MarkdownDocs } from "../../MarkdownDocs";

// The guide is media.md beside this file.
const { pageTitle, description } = docsGuide("1.1.0", "media");
export const metadata: Metadata = { title: pageTitle, description };

export default function Guide() {
  return <MarkdownDocs version="1.1.0" topic="media" />;
}
