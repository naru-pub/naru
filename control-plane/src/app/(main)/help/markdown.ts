import { readFileSync } from "node:fs";
import { join } from "node:path";
import MarkdownIt from "markdown-it";

// Help guides are written in Markdown, beside their pages as <topic>/page.md:
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
// contents. {{name}} is replaced with the page's value of that name, for
// what the code knows (an address, a list of extensions). The files are
// ours, so HTML in them (<kbd>) is kept.

const markdown = new MarkdownIt({ html: true, linkify: false });

// Wide tables scroll on their own instead of the page.
markdown.renderer.rules.table_open = () =>
  '<div class="overflow-x-auto"><table>';
markdown.renderer.rules.table_close = () => "</table></div>";

export type HelpDocument = {
  title: string;
  /** The browser's title for the page. */
  pageTitle: string;
  description: string;
  path: string;
  lead: string;
  links?: string;
  sections: { id: string; title: string; html: string }[];
};

const HEADING = /^## (.+?) \{#([a-z0-9-]+)\}\s*$/;

/** The guide at help/<topic>/page.md, rendered. Read once, at build. */
export function loadHelp(
  topic: string,
  values: Record<string, string> = {},
): HelpDocument {
  const source = readFileSync(
    join(process.cwd(), "src/app/(main)/help", topic, "page.md"),
    "utf8",
  ).replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    if (!Object.hasOwn(values, name))
      throw new Error(`help/${topic}/page.md: no value for {{${name}}}`);
    return values[name];
  });
  const front = /^---\n([\s\S]*?)\n---\n/.exec(source);
  if (!front) throw new Error(`help/${topic}/page.md has no front matter`);
  const fields = Object.fromEntries(
    front[1].split("\n").map((line) => {
      const colon = line.indexOf(":");
      return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
    }),
  );
  for (const field of ["title", "pageTitle", "description", "path"])
    if (!fields[field])
      throw new Error(`help/${topic}/page.md needs "${field}"`);

  const chunks: { id: string; title: string; lines: string[] }[] = [];
  const lead: string[] = [];
  for (const line of source.slice(front[0].length).split("\n")) {
    const heading = HEADING.exec(line);
    if (heading) chunks.push({ title: heading[1], id: heading[2], lines: [] });
    else if (line.startsWith("## "))
      throw new Error(`help/${topic}/page.md: "${line}" needs an {#id}`);
    else (chunks.at(-1)?.lines ?? lead).push(line);
  }
  return {
    title: fields.title,
    pageTitle: fields.pageTitle,
    description: fields.description,
    path: fields.path,
    lead: markdown.renderInline(lead.join(" ").trim()),
    links: fields.links ? markdown.renderInline(fields.links) : undefined,
    sections: chunks.map(({ id, title, lines }) => ({
      id,
      title,
      html: markdown.render(lines.join("\n")),
    })),
  };
}
