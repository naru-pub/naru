import type { Metadata } from "next";
import { ALLOWED_FILE_EXTENSIONS } from "@/lib/const";
import { MarkdownHelp } from "../HelpPage";
import { loadHelp } from "../markdown";

// The guide is page.md beside this file.
const document = () =>
  loadHelp("files", {
    extensions: ALLOWED_FILE_EXTENSIONS.map(
      (extension) => `\`${extension}\``,
    ).join(", "),
  });

export function generateMetadata(): Metadata {
  const { pageTitle, description } = document();
  return { title: pageTitle, description };
}

export default function FilesHelp() {
  return <MarkdownHelp current="files" document={document()} />;
}
