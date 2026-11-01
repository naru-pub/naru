import { MarkdownGuide } from "@/components/GuideFrame";
import { readGuide, renderGuide } from "@/lib/guide-markdown";
import DocsNav from "./DocsNav";
import { LATEST_VERSION } from "./versions";

// The manual for people using Naru, _guides/<topic>.md: not tied to an SDK
// version, and its code is addresses and shortcuts, so it isn't highlighted.
type Topic = "files" | "mcp";

/** The guide, with the values its {{names}} take. */
export const userGuide = (topic: Topic, values: Record<string, string> = {}) =>
  readGuide(`docs/_guides/${topic}.md`, values);

export function UserGuide({
  current,
  values,
}: {
  current: Topic;
  values?: Record<string, string>;
}) {
  const guide = renderGuide(userGuide(current, values));
  return (
    <MarkdownGuide
      guide={guide}
      nav={<DocsNav current={current} version={LATEST_VERSION} />}
      crumb={`NARU / DOCS / ${guide.path}`}
    />
  );
}
