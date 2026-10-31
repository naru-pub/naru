import type { Metadata } from "next";
import { mcpResource } from "@/lib/mcp/oauth";
import { HelpGuide, helpGuide } from "../HelpPage";

// The guide is page.md beside this file.
const values = () => ({ mcp_url: mcpResource() });

export function generateMetadata(): Metadata {
  const { pageTitle, description } = helpGuide("mcp", values());
  return { title: pageTitle, description };
}

export default function McpHelp() {
  return <HelpGuide current="mcp" values={values()} />;
}
