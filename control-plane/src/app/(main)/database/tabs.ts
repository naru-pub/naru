/** The /database tabs, by the `?tab=` value that links to each. */
export const TABS = [
  "collections",
  "tables",
  "access",
  "members",
  "restore",
  "sdk",
] as const;
export type Tab = (typeof TABS)[number];

export function isTab(value: unknown): value is Tab {
  return TABS.includes(value as Tab);
}
