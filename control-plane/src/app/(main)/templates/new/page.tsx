import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { validateRequest } from "@/lib/auth";
import { listTemplateTags } from "@/lib/board/posts";
import { listCollections } from "@/lib/site-data/service";
import { TemplateForm } from "./TemplateForm";

export const metadata: Metadata = { title: "템플릿 등록하기 · 나루" };

export default async function NewTemplatePage() {
  const { user } = await validateRequest();
  if (!user) redirect("/login");

  if (!user.emailVerifiedAt) {
    return (
      <div className="bg-background min-h-screen p-4 sm:p-6">
        <main className="mx-auto max-w-3xl space-y-4 border-2 border-line p-6">
          <h1 className="text-2xl font-bold">템플릿 등록하기</h1>
          <p className="text-sm text-muted-foreground">
            템플릿을 등록하려면{" "}
            <Link href="/account" className="text-primary hover:underline">
              계정 설정
            </Link>
            에서 이메일을 인증해 주세요.
          </p>
        </main>
      </div>
    );
  }

  const [collections, popularTags] = await Promise.all([
    listCollections(user),
    listTemplateTags(10),
  ]);

  return (
    <div className="bg-background min-h-screen p-4 sm:p-6">
      <main className="mx-auto max-w-3xl space-y-6">
        <div className="space-y-1">
          <Link
            href="/templates"
            className="text-xs text-primary hover:underline"
          >
            ← 템플릿
          </Link>
          <h1 className="text-2xl font-bold">템플릿 등록하기</h1>
          <p className="text-sm text-muted-foreground">
            처음이라면{" "}
            <Link href="/docs/templates" className="text-primary underline">
              템플릿 개발자 가이드
            </Link>
            를 먼저 읽어 보세요.
          </p>
        </div>
        <TemplateForm
          collections={collections.map((c) => c.name)}
          tagSuggestions={popularTags.map(({ tag }) => tag)}
        />
      </main>
    </div>
  );
}
