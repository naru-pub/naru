import type { Metadata } from "next";
import { mcpResource } from "@/lib/mcp/oauth";
import { UserGuide, userGuide } from "../UserGuide";

// The guide is _guides/ai.md.
const values = () => ({ mcp_url: mcpResource() });

export function generateMetadata(): Metadata {
  const { pageTitle, description } = userGuide("ai", values());
  return { title: pageTitle, description };
}

export default function AiGuide() {
  return <UserGuide current="ai" values={values()} />;
}
