import type { Metadata } from "next";
import Link from "next/link";
import { validateRequest } from "@/lib/auth";
import { authoredTemplates } from "@/lib/board/updates";

export const metadata: Metadata = {
  title: "개발자 | 나루",
  description: "사이트 코드와 Data SDK로 만든 템플릿을 공개하고 관리하는 곳",
};

const GUIDE = "/docs/templates";
const NEW_TEMPLATE = "/board/new?kind=template";

const PANEL = "border-2 border-line bg-card";
const LINK = "font-bold text-link underline-offset-4 hover:underline";
const BUTTON =
  "inline-flex min-h-11 items-center border-2 border-line px-5 font-bold";

export default async function DevelopersPage() {
  const { user } = await validateRequest();
  const templates = user ? await authoredTemplates(user.id) : [];

  return (
    <div className="min-h-screen">
      <div className="mx-auto flex max-w-7xl flex-col gap-10 px-4 pb-16 pt-10 sm:px-6 lg:px-8">
        <section className="flex flex-wrap items-end justify-between gap-x-8 gap-y-6">
          <div className="flex max-w-2xl flex-[1_1_32rem] flex-col gap-3">
            <p className="font-mono text-sm text-muted-foreground">
              NARU / DEVELOPERS
            </p>
            <h1 className="text-4xl font-bold tracking-tight">
              나루에서 만들기
            </h1>
            <p className="text-lg leading-relaxed text-muted-foreground">
              사이트 코드(_naru/)와 Data SDK로 만든 템플릿을 공개하고 관리하는
              곳이에요. SDK와 사이트 코드는{" "}
              <Link href="/docs" className={LINK}>
                문서
              </Link>
              에 있어요.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link href={GUIDE} className={`${BUTTON} press bg-card`}>
              템플릿 가이드
            </Link>
            <Link
              href={NEW_TEMPLATE}
              className={`${BUTTON} press bg-primary text-primary-foreground`}
            >
              새 템플릿 공개하기
            </Link>
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
