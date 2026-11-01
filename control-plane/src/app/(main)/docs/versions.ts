export const DOC_VERSIONS = ["1.0.0", "1.1.0"] as const;
export type DocsVersion = (typeof DOC_VERSIONS)[number];
export const isDocsVersion = (value: string): value is DocsVersion =>
  DOC_VERSIONS.some((version) => version === value);
export const LATEST_VERSION: DocsVersion = "1.1.0";
export const guidePath = (version: DocsVersion, topic: string) =>
  topic === "sdk" ? `/docs/sdk/${version}` : `/docs/${version}/${topic}`;
