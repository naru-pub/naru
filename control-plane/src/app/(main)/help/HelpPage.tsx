import { MarkdownGuide } from "@/components/GuideFrame";
import { readGuide, renderGuide } from "@/lib/guide-markdown";

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

/** The guide help/<topic>/page.md, with the values its {{names}} take. */
export const helpGuide = (
  topic: Exclude<HelpTopic, "home">,
  values: Record<string, string> = {},
) => readGuide(`help/${topic}/page.md`, values);

export function HelpGuide({
  current,
  values,
}: {
  current: Exclude<HelpTopic, "home">;
  values?: Record<string, string>;
}) {
  const guide = renderGuide(helpGuide(current, values));
  return (
    <MarkdownGuide
      guide={guide}
      nav={<HelpNav current={current} />}
      crumb={`NARU / HELP / ${guide.path}`}
    />
  );
}
