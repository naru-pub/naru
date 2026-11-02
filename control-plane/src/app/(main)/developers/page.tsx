import type { Metadata } from "next";
import Link from "next/link";
import { validateRequest } from "@/lib/auth";
import { authoredTemplates } from "@/lib/board/updates";
import DocsNav from "../docs/DocsNav";
import { LATEST_VERSION, guidePath } from "../docs/versions";

export const metadata: Metadata = {
  title: "개발자 | 나루",
  description: "사이트 코드와 Data SDK 문서, 내가 공개한 템플릿을 모은 곳",
};

const GUIDE = "/docs/templates";
const NEW_TEMPLATE = "/templates/new";

const GUIDES = [
  {
    href: guidePath(LATEST_VERSION, "database"),
    title: "데이터베이스",
    summary: "컬렉션과 사이트 코드로 페이지의 데이터를 저장하고 읽어요.",
  },
  {
    href: guidePath(LATEST_VERSION, "media"),
    title: "미디어",
    summary: "사이트가 올린 이미지와 파일을 다뤄요.",
  },
  {
    href: guidePath(LATEST_VERSION, "sdk"),
    title: "SDK 레퍼런스",
    summary: `Data SDK ${LATEST_VERSION}의 모든 함수와 타입.`,
  },
  {
    href: "/docs/dev",
    title: "로컬 개발",
    summary: "naru-dev로 사이트를 내 컴퓨터에서 돌려 보고 시험해요.",
  },
  {
    href: GUIDE,
    title: "템플릿 만들기",
    summary: "빈 폴더에서 공개한 템플릿까지 세 단계로 가요.",
  },
];

const PANEL = "border-2 border-line bg-card";
const LINK = "font-bold text-link underline-offset-4 hover:underline";
const BUTTON =
  "inline-flex min-h-11 items-center border-2 border-line px-5 font-bold";

export default async function DevelopersPage() {
  const { user } = await validateRequest();
  const templates = user ? await authoredTemplates(user.id) : [];

  return (
    <div className="min-h-screen">
      <div className="mx-auto flex max-w-6xl flex-col gap-10 px-5 py-12 md:px-8">
        <div className="-mb-10">
          <DocsNav current="developers" version={LATEST_VERSION} />
        </div>
        <section className="flex flex-wrap items-end justify-between gap-x-8 gap-y-6">
          <div className="flex max-w-2xl flex-[1_1_32rem] flex-col gap-3">
            <p className="font-mono text-sm text-muted-foreground">
              NARU / DEVELOPERS
            </p>
            <h1 className="text-4xl font-bold tracking-tight">
              나루에서 만들기
            </h1>
            <p className="text-lg leading-relaxed text-muted-foreground">
              사이트 코드(_naru/)와 Data SDK로 사이트와 템플릿을 만들 때 필요한
              것을 모았어요.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link
              href={NEW_TEMPLATE}
              className={`${BUTTON} press bg-primary text-primary-foreground`}
            >
              템플릿 등록하기
            </Link>
          </div>
        </section>

        <section aria-labelledby="guides" className="flex flex-col gap-5">
          <h2 id="guides" className="text-xl font-bold">
            문서
          </h2>
          <div className="grid gap-6 md:grid-cols-2">
            {GUIDES.map((guide) => (
              <Link
                key={guide.href}
                href={guide.href}
                className="group block border-2 border-line bg-card p-6 transition-colors hover:bg-accent"
              >
                <h3 className="text-xl font-bold group-hover:text-link">
                  {guide.title} →
                </h3>
                <p className="mt-3 leading-7 text-muted-foreground">
                  {guide.summary}
                </p>
              </Link>
            ))}
          </div>
        </section>

        {user && (
          <section
            aria-labelledby="mine"
            className={`${PANEL} flex flex-col gap-2.5 p-5`}
          >
            <span className="flex items-baseline justify-between gap-3">
              <Link
                id="mine"
                href="/developers/templates"
                className="text-lg font-bold underline-offset-4 hover:underline"
              >
                내 템플릿 →
              </Link>
              <span className="font-mono text-sm text-muted-foreground">
                {templates.length}개
              </span>
            </span>
            {templates.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                아직 공개한 템플릿이 없어요.{" "}
                <Link href={GUIDE} className={LINK}>
                  템플릿 가이드
                </Link>
                를 따라 하나 만들어 봐요.
              </p>
            ) : (
              <ul className="flex flex-col text-sm">
                {templates.map((template) => (
                  <li
                    key={template.postId}
                    className="flex flex-wrap items-baseline justify-between gap-x-3 border-b border-border py-2 last:border-b-0"
                  >
                    <Link href={`/board/${template.postId}`} className={LINK}>
                      {template.title}
                    </Link>
                    <span className="text-muted-foreground">
                      {template.version !== null && `v${template.version}`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
