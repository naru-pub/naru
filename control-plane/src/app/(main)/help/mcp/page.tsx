import type { Metadata } from "next";
import { mcpResource } from "@/lib/mcp/oauth";
import { MarkdownHelp } from "../HelpPage";
import { loadHelp } from "../markdown";

// The guide is page.md beside this file.
const document = () => loadHelp("mcp", { mcp_url: mcpResource() });

export function generateMetadata(): Metadata {
  const { pageTitle, description } = document();
  return { title: pageTitle, description };
}

export default function McpHelp() {
  return <MarkdownHelp current="mcp" document={document()} />;
}
