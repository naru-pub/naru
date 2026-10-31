import type { Metadata } from "next";
import { ALLOWED_FILE_EXTENSIONS } from "@/lib/const";
import { HelpGuide, helpGuide } from "../HelpPage";

// The guide is page.md beside this file.
const values = () => ({
  extensions: ALLOWED_FILE_EXTENSIONS.map(
    (extension) => `\`${extension}\``,
  ).join(", "),
});

export function generateMetadata(): Metadata {
  const { pageTitle, description } = helpGuide("files", values());
  return { title: pageTitle, description };
}

export default function FilesHelp() {
  return <HelpGuide current="files" values={values()} />;
}
