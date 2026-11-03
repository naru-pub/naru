import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { validateRequest } from "@/lib/auth";
import { markTemplateNotificationsRead } from "@/lib/board/replies";
import { listInstalls } from "@/lib/board/updates";
import { InstallCard } from "./InstallCard";

export const metadata: Metadata = { title: "설치한 템플릿 · 나루" };

// The templates installed on the signed-in person's site, with their updates.
export default async function TemplatesPage() {
  const { user } = await validateRequest();
  if (!user) redirect("/login");
  const installs = await listInstalls(user);
  // This page is where new versions are taken, so their notices are read.
  await markTemplateNotificationsRead(user.id);

  return (
    <div className="bg-background min-h-screen p-4 sm:p-6">
      <main className="mx-auto max-w-3xl space-y-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold">설치한 템플릿</h1>
          <p className="text-sm text-muted-foreground">
            새 버전이 나오면 여기서 업데이트해요. 템플릿이 설치한 파일만 바뀌고,
            직접 고친 파일은 보관해 둬요.{" "}
            <Link href="/docs/using-templates#updates" className="underline">
              자세히 보기
            </Link>
          </p>
        </div>
        {installs.length === 0 ? (
          <p className="border-2 border-line p-6 text-sm text-muted-foreground">
            아직 설치한 템플릿이 없어요.{" "}
            <Link href="/templates" className="underline">
              템플릿 둘러보기
            </Link>
          </p>
        ) : (
          installs.map((install) => (
            <InstallCard key={install.id} install={install} />
          ))
        )}
        {installs.length > 0 && (
          <p className="text-sm text-muted-foreground">
            색이나 배치를 바꾸고 싶다면{" "}
            <Link
              href="/ai"
              className="text-link underline-offset-4 hover:underline"
            >
              AI 앱에게 부탁해 보세요 →
            </Link>
          </p>
        )}
      </main>
    </div>
  );
}
