import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { validateRequest } from "@/lib/auth";
import { listInstalls } from "@/lib/board/updates";
import { InstallCard } from "./InstallCard";

export const metadata: Metadata = { title: "설치한 템플릿 · 나루" };

// The templates installed on the signed-in person's site, with their updates.
export default async function TemplatesPage() {
  const { user } = await validateRequest();
  if (!user) redirect("/login");
  const installs = await listInstalls(user);

  return (
    <div className="bg-background min-h-screen p-4 sm:p-6">
      <main className="mx-auto max-w-3xl space-y-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold">설치한 템플릿</h1>
          <p className="text-sm text-muted-foreground">
            새 버전이 나오면 여기서 업데이트해요. 템플릿이 설치한 파일만 바뀌고,
            직접 고친 파일은 보관해 둬요.
          </p>
        </div>
        {installs.length === 0 ? (
          <p className="border-2 border-line p-6 text-sm text-muted-foreground">
            아직 설치한 템플릿이 없어요.{" "}
            <Link href="/board?kind=template" className="underline">
              게시판에서 템플릿 둘러보기
            </Link>
          </p>
        ) : (
          installs.map((install) => (
            <InstallCard key={install.id} install={install} />
          ))
        )}
      </main>
    </div>
  );
}
