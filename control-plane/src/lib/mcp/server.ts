import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { siteOrigins } from "@/lib/app-api/sites";
import { ALLOWED_FILE_EXTENSIONS } from "@/lib/const";
import { db } from "@/lib/database";
import { getUserEntitlement } from "@/lib/entitlements";
import { getHomepageUrl } from "@/lib/site-urls";
import type { McpGrant } from "./oauth";
import { naruOrigin } from "./oauth";
import {
  deleteFile,
  FileError,
  filePath,
  fileUrl,
  folderPath,
  listFiles,
  MAX_FILE_BYTES,
  MAX_READ_BYTES,
  moveFile,
  readFile,
  writeFile,
  type Site,
} from "./site-files";

// Naru MCP's tools (docs/design/naru-mcp.md): the connected account's site,
// its address and its files. A connection with only the read scope is not
// offered the tools that change files. Tool text is English, which every
// MCP app's model reads; it says what Naru is and nothing about who writes.

const VERSION = "1.0.0";

function instructions(site: Site) {
  return `This server is one Naru site: ${getHomepageUrl(site.loginName)}, owned by the account "${site.loginName}". Naru hosts static websites: every file is served as it is at <site address>/<path>, with no build step and no server-side code. index.html at the root is the home page, and a folder's index.html is that folder's page. Files under _naru/ are the site's private configuration, never served (for example _naru/collections.json, which declares the site's database collections). Pages can store data with the Naru Data SDK, documented at ${naruOrigin()}/docs. Paths are relative to the site's root, such as index.html or css/site.css.`;
}

const text = (value: unknown): CallToolResult => ({
  content: [
    {
      type: "text",
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    },
  ],
});

const failure = (message: string): CallToolResult => ({
  ...text(message),
  isError: true,
});

/**
 * A tool's work, with what can go wrong said to the model: FileError as it is,
 * an account without the plan as such, anything else as Naru's own failure.
 */
function tool<A>(
  entitled: boolean,
  run: (args: A) => Promise<CallToolResult>,
): (args: A) => Promise<CallToolResult> {
  return async (args) => {
    if (!entitled)
      return failure(
        `Naru MCP is part of the Naru supporter plan, which this account doesn't have now. The owner can subscribe at ${naruOrigin()}/supporter.`,
      );
    try {
      return await run(args);
    } catch (error) {
      if (error instanceof FileError) return failure(error.message);
      Sentry.captureException(error);
      console.error("MCP tool error:", error);
      return failure("Naru could not finish this. Try again in a moment.");
    }
  };
}

/** A server for one request of one connection. */
export function naruMcpServer(grant: McpGrant, entitled: boolean) {
  const site: Site = { userId: grant.userId, loginName: grant.loginName };
  const server = new McpServer(
    { name: "naru", title: "Naru", version: VERSION },
    { instructions: instructions(site) },
  );
  const canWrite = grant.scopes.includes("write");

  server.registerTool(
    "get_site",
    {
      title: "Get site",
      description:
        "The site's address, title, when it last changed, until when the account's plan is open, and the limits on its files.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool(entitled, async () => {
      const [origins, row, entitlement] = await Promise.all([
        siteOrigins([site.loginName]),
        db
          .selectFrom("users")
          .select(["site_title", "site_updated_at"])
          .where("id", "=", site.userId)
          .executeTakeFirstOrThrow(),
        getUserEntitlement(site.userId),
      ]);
      return text({
        name: site.loginName,
        address: origins.get(site.loginName),
        naruAddress: getHomepageUrl(site.loginName),
        title: row.site_title,
        lastChanged: row.site_updated_at
          ? new Date(row.site_updated_at).toISOString()
          : null,
        planOpenUntil: entitlement.comp
          ? "no end"
          : (entitlement.accessEndsAt?.toISOString() ?? null),
        canWrite,
        limits: {
          maxFileBytes: MAX_FILE_BYTES,
          allowedExtensions: ALLOWED_FILE_EXTENSIONS,
        },
      });
    }),
  );

  server.registerTool(
    "list_files",
    {
      title: "List files",
      description:
        "The site's files under a folder (the whole site when left out), with their sizes and when they last changed. Lists at most 2000.",
      inputSchema: {
        folder: z
          .string()
          .max(1000)
          .optional()
          .describe("A folder relative to the site's root, such as css."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool(entitled, async ({ folder }: { folder?: string }) => {
      const listed = await listFiles(site, folderPath(folder));
      return text({
        files: listed.files.map((file) => ({
          ...file,
          url: fileUrl(site, file.path),
        })),
        truncated: listed.truncated,
      });
    }),
  );

  server.registerTool(
    "read_file",
    {
      title: "Read file",
      description: `A file's content: text files as text and images as images, up to ${MAX_READ_BYTES / 1024 / 1024} MB. Larger and other files are described with their address.`,
      inputSchema: {
        path: z
          .string()
          .max(1000)
          .describe("The file's path relative to the site's root."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool(entitled, async ({ path: value }: { path: string }) => {
      const path = filePath(value);
      const file = await readFile(site, path);
      if (file.kind === "text") return text(file.text);
      if (file.kind === "image")
        return {
          content: [
            { type: "image", data: file.data, mimeType: file.mimeType },
          ],
        };
      return text({
        path,
        size: file.size,
        contentType: file.contentType,
        url: fileUrl(site, path),
        note: "Not returned: only text files and images up to 1 MB are.",
      });
    }),
  );

  if (!canWrite) return server;

  server.registerTool(
    "write_file",
    {
      title: "Write file",
      description:
        "Creates a file or replaces it whole, and publishes it at once. Text goes as it is; images, fonts and audio go as base64. Folders are made as needed.",
      inputSchema: {
        path: z
          .string()
          .max(1000)
          .describe("The file's path relative to the site's root."),
        content: z.string().describe("The whole file."),
        encoding: z
          .enum(["utf8", "base64"])
          .optional()
          .describe("base64 for a binary file; utf8 (the default) for text."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    tool(
      entitled,
      async ({
        path: value,
        content,
        encoding,
      }: {
        path: string;
        content: string;
        encoding?: "utf8" | "base64";
      }) => {
        const path = filePath(value);
        const body = Buffer.from(content, encoding ?? "utf8");
        const result = await writeFile(site, path, body);
        return text({
          path,
          created: result.created,
          size: result.size,
          url: fileUrl(site, path),
        });
      },
    ),
  );

  server.registerTool(
    "move_file",
    {
      title: "Move file",
      description:
        "Moves or renames a file. Refuses when a file is already at the new path. The old address stops working.",
      inputSchema: {
        from: z.string().max(1000).describe("The file's current path."),
        to: z.string().max(1000).describe("The file's new path."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    tool(entitled, async ({ from, to }: { from: string; to: string }) => {
      const source = filePath(from);
      const target = filePath(to);
      await moveFile(site, source, target);
      return text({ from: source, to: target, url: fileUrl(site, target) });
    }),
  );

  server.registerTool(
    "delete_file",
    {
      title: "Delete file",
      description:
        "Deletes one file from the site. It can't be undone. The home page, index.html, can't be deleted.",
      inputSchema: {
        path: z
          .string()
          .max(1000)
          .describe("The file's path relative to the site's root."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    tool(entitled, async ({ path: value }: { path: string }) => {
      const path = filePath(value);
      await deleteFile(site, path);
      return text({ deleted: path });
    }),
  );

  return server;
}
