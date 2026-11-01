import type { Metadata } from "next";
import { ALLOWED_FILE_EXTENSIONS } from "@/lib/const";
import { UserGuide, userGuide } from "../UserGuide";

// The guide is _guides/files.md.
const values = () => ({
  extensions: ALLOWED_FILE_EXTENSIONS.map(
    (extension) => `\`${extension}\``,
  ).join(", "),
});

export function generateMetadata(): Metadata {
  const { pageTitle, description } = userGuide("files", values());
  return { title: pageTitle, description };
}

export default function FilesGuide() {
  return <UserGuide current="files" values={values()} />;
}
