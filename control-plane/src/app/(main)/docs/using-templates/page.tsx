import type { Metadata } from "next";
import { OWNER_DIRECTORY } from "@/lib/board/installs";
import { UserGuide, userGuide } from "../UserGuide";

// The guide is _guides/using-templates.md.
const values = () => ({ owner: OWNER_DIRECTORY });

export function generateMetadata(): Metadata {
  const { pageTitle, description } = userGuide("using-templates", values());
  return { title: pageTitle, description };
}

export default function UsingTemplatesGuide() {
  return <UserGuide current="using-templates" values={values()} />;
}
