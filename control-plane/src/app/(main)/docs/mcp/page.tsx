import type { Metadata } from "next";
import { mcpResource } from "@/lib/mcp/oauth";
import { UserGuide, userGuide } from "../UserGuide";

// The guide is _guides/mcp.md.
const values = () => ({ mcp_url: mcpResource() });

export function generateMetadata(): Metadata {
  const { pageTitle, description } = userGuide("mcp", values());
  return { title: pageTitle, description };
}

export default function McpGuide() {
  return <UserGuide current="mcp" values={values()} />;
}
