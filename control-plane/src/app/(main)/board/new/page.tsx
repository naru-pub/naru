import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { validateRequest } from "@/lib/auth";
import { NewPostForm } from "./NewPostForm";

export const metadata: Metadata = { title: "내 사이트 자랑하기 · 나루" };

export default async function NewPostPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string }>;
}) {
  // Templates are registered on their own page; older links still arrive here.
  if ((await searchParams).kind === "template") redirect("/templates/new");
  const { user } = await validateRequest();
  if (!user) redirect("/login");

  if (!user.emailVerifiedAt) {
    return (
      <div className="bg-background min-h-screen p-4 sm:p-6">
        <main className="mx-auto max-w-3xl space-y-4 border-2 border-line p-6">
          <h1 className="text-2xl font-bold">내 사이트 자랑하기</h1>
          <p className="text-sm text-muted-foreground">
            자랑 글을 쓰려면{" "}
            <Link href="/account" className="text-primary hover:underline">
              계정 설정
            </Link>
            에서 이메일을 인증해 주세요.
          </p>
        </main>
      </div>
    );
  }

  return (
    <div className="bg-background min-h-screen p-4 sm:p-6">
      <main className="mx-auto max-w-3xl space-y-6">
        <div className="space-y-1">
          <Link href="/board" className="text-xs text-primary hover:underline">
            ← 자랑
          </Link>
          <h1 className="text-2xl font-bold">내 사이트 자랑하기</h1>
        </div>
        <NewPostForm />
      </main>
    </div>
  );
}
