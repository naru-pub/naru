import {
  DOC_VERSIONS,
  guidePath,
  LATEST_VERSION,
  type DocsVersion,
} from "./versions";

// Only the SDK's guides have versions to switch between.
const VERSIONED = ["database", "media", "sdk"];

export default function DocsNav({
  current,
  version = "1.0.0",
}: {
  current: string;
  version?: DocsVersion;
}) {
  // People making a homepage and people writing code each see their own guides.
  const forEveryone = [
    ["/docs", "길잡이", "home"],
    ["/docs/files", "파일 편집기", "files"],
    ["/docs/ai", "AI 앱 연결", "ai"],
    ["/docs/using-templates", "템플릿 쓰기", "using-templates"],
  ];
  const forDevelopers = [
    ["/developers", "개발자", "developers"],
    [guidePath(version, "database"), "데이터베이스", "database"],
    [guidePath(version, "media"), "미디어", "media"],
    [guidePath(version, "sdk"), `SDK ${version}`, "sdk"],
    ["/docs/dev", "로컬 개발", "dev"],
    ["/docs/templates", "템플릿 만들기", "templates"],
  ];
  const links = forEveryone.some(([, , key]) => key === current)
    ? forEveryone
    : forDevelopers;
  return (
    <nav aria-label="문서" className="mb-10">
      {VERSIONED.includes(current) && (
        <div
          className="mb-4 flex flex-wrap items-center gap-3 text-sm"
          aria-label="SDK 버전"
        >
          <span>SDK 버전</span>
          {DOC_VERSIONS.map((value) => (
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
              {value} ·{" "}
              {value === LATEST_VERSION
                ? "최신"
                : DOC_VERSIONS.indexOf(value) >
                    DOC_VERSIONS.indexOf(LATEST_VERSION)
                  ? "개발 중"
                  : "이전"}
            </a>
          ))}
        </div>
      )}
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
