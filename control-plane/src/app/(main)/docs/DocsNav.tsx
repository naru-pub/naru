import { DOC_VERSIONS, guidePath, type DocsVersion } from "./versions";

export default function DocsNav({
  current,
  version = "1.0.0",
}: {
  current: string;
  version?: DocsVersion;
}) {
  const links = [
    ["/developers", "개발자", "developers"],
    [guidePath(version, "database"), "데이터베이스", "database"],
    [guidePath(version, "media"), "미디어", "media"],
    [guidePath(version, "sdk"), `SDK ${version}`, "sdk"],
    ["/docs/mcp", "MCP 연결", "mcp"],
  ] as const;
  return (
    <nav aria-label="문서" className="mb-10">
      <div
        className="mb-4 flex flex-wrap items-center gap-3 text-sm"
        aria-label="SDK 버전"
      >
        <span>SDK 버전</span>
        {DOC_VERSIONS.filter((value) => value !== "1.1.0").map((value) => (
          <a
            key={value}
            href={guidePath(value, current)}
            aria-current={version === value ? "true" : undefined}
            className={
              version === value
                ? "font-bold underline underline-offset-4"
                : "text-muted-foreground"
            }
          >
            {value} · {value === "1.0.0" ? "안정" : "개발 중"}
          </a>
        ))}
      </div>
      <ul className="flex flex-wrap gap-2 text-sm">
        {links.map(([href, label, key]) => (
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
