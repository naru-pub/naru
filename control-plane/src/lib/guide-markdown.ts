import { readFileSync } from "node:fs";
import { join } from "node:path";
import MarkdownIt from "markdown-it";

// Guides written in Markdown: the help pages (help/<topic>/page.md) and the
// SDK guides (docs/_guides/<version>/<topic>.md), which Naru MCP also gives
// models as they are (lib/mcp/sdk-reference.ts).
//
//   ---
//   title: 파일 편집기로 홈페이지 만들기
//   pageTitle: 파일 편집기 | 나루
//   description: (the page's meta description)
//   path: FILES
//   links: [파일 편집기 열기 →](/files)
//   ---
//   The lead paragraph.
//
//   ## 01 · 첫 페이지 고치기 {#start}
//   ...
//
// Each "## Title {#id}" starts a section and an entry in the table of
// contents. {{name}} is replaced with the caller's value of that name, for
// what the code knows (an address, a site's name). The files are ours, so
// HTML in them (<kbd>) is kept.

const markdown = new MarkdownIt({ html: true, linkify: false });

// Wide tables scroll on their own instead of the page.
markdown.renderer.rules.table_open = () =>
  '<div class="overflow-x-auto"><table>';
markdown.renderer.rules.table_close = () => "</table></div>";

/** What render() is given: how a page draws its code blocks, if its own way. */
type RenderEnv = { code?: (code: string, language: string) => string };

const plainFence = markdown.renderer.rules.fence!;
markdown.renderer.rules.fence = (
  tokens,
  index,
  options,
  env: RenderEnv,
  self,
) =>
  env.code
    ? env.code(tokens[index].content, tokens[index].info.trim())
    : plainFence(tokens, index, options, env, self);

export type Guide = {
  title: string;
  /** The browser's title for the page. */
  pageTitle: string;
  description: string;
  path: string;
  /** Markdown, as the file has it. */
  lead: string;
  links?: string;
  sections: { id: string; title: string; markdown: string }[];
};

export type RenderedGuide = Omit<Guide, "sections"> & {
  sections: { id: string; title: string; html: string }[];
};

const HEADING = /^## (.+?) \{#([a-z0-9-]+)\}\s*$/;
const sources = new Map<string, string>();

/**
 * The guide at `file`, relative to src/app/(main), with its {{names}} filled
 * in. Each file is read once a process.
 */
export function readGuide(
  file: string,
  values: Record<string, string> = {},
): Guide {
  if (!sources.has(file))
    sources.set(
      file,
      readFileSync(join(process.cwd(), "src/app/(main)", file), "utf8"),
    );
  const source = sources
    .get(file)!
    .replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
      if (!Object.hasOwn(values, name))
        throw new Error(`${file}: no value for {{${name}}}`);
      return values[name];
    });
  const front = /^---\n([\s\S]*?)\n---\n/.exec(source);
  if (!front) throw new Error(`${file} has no front matter`);
  const fields = Object.fromEntries(
    front[1].split("\n").map((line) => {
      const colon = line.indexOf(":");
      return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
    }),
  );
  for (const field of ["title", "pageTitle", "description", "path"])
    if (!fields[field]) throw new Error(`${file} needs "${field}"`);

  const chunks: { id: string; title: string; lines: string[] }[] = [];
  const lead: string[] = [];
  for (const line of source.slice(front[0].length).split("\n")) {
    const heading = HEADING.exec(line);
    if (heading) chunks.push({ title: heading[1], id: heading[2], lines: [] });
    else if (line.startsWith("## "))
      throw new Error(`${file}: "${line}" needs an {#id}`);
    else (chunks.at(-1)?.lines ?? lead).push(line);
  }
  return {
    title: fields.title,
    pageTitle: fields.pageTitle,
    description: fields.description,
    path: fields.path,
    lead: lead.join("\n").trim(),
    links: fields.links || undefined,
    sections: chunks.map(({ id, title, lines }) => ({
      id,
      title,
      markdown: lines.join("\n").trim(),
    })),
  };
}

/** A guide as HTML, its code blocks drawn by `code` when given. */
export function renderGuide(guide: Guide, env: RenderEnv = {}): RenderedGuide {
  return {
    ...guide,
    lead: markdown.renderInline(guide.lead.replace(/\n/g, " ")),
    links: guide.links ? markdown.renderInline(guide.links) : undefined,
    sections: guide.sections.map(({ id, title, markdown: text }) => ({
      id,
      title,
      html: markdown.render(text, env),
    })),
  };
}
