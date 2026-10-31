import type { ReactNode } from "react";
import type { HelpDocument } from "./markdown";

// The manual for people using Naru: its pages, and the frame they share.
const PAGES = [
  ["/help", "도움말", "home"],
  ["/help/files", "파일 편집기", "files"],
  ["/help/mcp", "MCP 연결", "mcp"],
] as const;

export type HelpTopic = (typeof PAGES)[number][2];

export function HelpNav({ current }: { current: HelpTopic }) {
  return (
    <nav aria-label="도움말" className="mb-10">
      <ul className="flex flex-wrap gap-2 text-sm">
        {PAGES.map(([href, label, key]) => (
          <li key={href}>
            <a
              href={href}
              aria-current={current === key ? "page" : undefined}
              className={`block px-3 py-1.5 transition-colors ${
                current === key
                  ? "border-2 border-line bg-foreground text-background"
                  : "border-2 border-transparent text-muted-foreground hover:border-line hover:text-foreground"
              }`}
            >
              {label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-8 space-y-5 border-t pt-8">
      <h2 className="text-xl font-bold">{title}</h2>
      {children}
    </section>
  );
}

/** A guide: its header, a table of contents, and its sections. */
export function HelpPage({
  current,
  path,
  title,
  lead,
  links,
  sections,
  children,
}: {
  current: HelpTopic;
  // Shown after NARU / HELP, e.g. "FILES".
  path: string;
  title: string;
  lead: ReactNode;
  links?: ReactNode;
  sections: readonly (readonly [id: string, label: string])[];
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen">
      <div className="mx-auto max-w-6xl px-5 py-12 md:px-8">
        <HelpNav current={current} />
        <header className="mb-12 max-w-3xl space-y-5">
          <p className="text-sm text-muted-foreground">NARU / HELP / {path}</p>
          <h1 className="text-3xl font-bold tracking-tight md:text-4xl">
            {title}
          </h1>
          <p className="text-lg leading-8 text-muted-foreground">{lead}</p>
          {links && (
            <div className="flex flex-wrap gap-5 text-sm underline underline-offset-4">
              {links}
            </div>
          )}
        </header>

        <div className="grid gap-10 lg:grid-cols-[230px_minmax(0,1fr)]">
          <nav
            aria-label="문서 목차"
            className="self-start rounded-lg border p-5 lg:sticky lg:top-8"
          >
            <p className="mb-4 font-bold">이 페이지에서</p>
            <ul className="space-y-3 text-sm">
              {sections.map(([id, label]) => (
                <li key={id}>
                  <a
                    className="underline-offset-4 hover:underline"
                    href={`#${id}`}
                  >
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <article className="min-w-0 space-y-12 leading-8 [&_a]:underline [&_a]:underline-offset-4">
            {children}
          </article>
        </div>
      </div>
    </div>
  );
}

// What a Markdown guide renders, styled as the guides written in JSX were.
const MARKDOWN = [
  "space-y-5",
  "[&_ol]:list-decimal [&_ol]:space-y-3 [&_ol]:pl-6",
  "[&_ul]:list-disc [&_ul]:space-y-3 [&_ul]:pl-6",
  "[&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:border [&_pre]:bg-muted [&_pre]:px-4 [&_pre]:py-2 [&_pre]:text-sm [&_li>pre]:mt-2",
  "[&_table]:w-full [&_table]:text-left [&_table]:text-sm [&_tr]:border-b [&_th]:p-3 [&_td]:p-3 [&_td:first-child]:whitespace-nowrap",
  "[&_blockquote]:border-l-4 [&_blockquote]:border-line [&_blockquote]:bg-muted [&_blockquote]:px-4 [&_blockquote]:py-2",
  "[&_kbd]:border [&_kbd]:border-b-2 [&_kbd]:border-line [&_kbd]:bg-card [&_kbd]:px-1.5 [&_kbd]:py-0.5 [&_kbd]:font-mono [&_kbd]:text-sm",
].join(" ");

/** A guide written in Markdown (markdown.ts), in the guides' frame. */
export function MarkdownHelp({
  current,
  document,
}: {
  current: HelpTopic;
  document: HelpDocument;
}) {
  return (
    <HelpPage
      current={current}
      path={document.path}
      title={document.title}
      lead={<span dangerouslySetInnerHTML={{ __html: document.lead }} />}
      links={
        document.links && (
          <span
            className="flex flex-wrap gap-5"
            dangerouslySetInnerHTML={{ __html: document.links }}
          />
        )
      }
      sections={document.sections.map(({ id, title }) => [id, title] as const)}
    >
      {document.sections.map(({ id, title, html }) => (
        <Section key={id} id={id} title={title}>
          <div
            className={MARKDOWN}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </Section>
      ))}
    </HelpPage>
  );
}
