import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { validateRequest } from "@/lib/auth";
import { getPost } from "@/lib/board/posts";
import { filesStillPresent, getTemplateForPost } from "@/lib/board/templates";
import { listCollections } from "@/lib/site-data/service";
import { EditPostForm } from "./EditPostForm";
import { NewVersionForm } from "./NewVersionForm";
import { PreviewForm } from "./PreviewForm";
import { SourceForm } from "./SourceForm";

export const metadata: Metadata = { title: "글 고치기 · 나루 게시판" };

export default async function EditPostPage({
  params,
}: {
  params: Promise<{ postId: string }>;
}) {
  const { postId } = await params;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      postId,
    )
  )
    notFound();
  const { user } = await validateRequest();
  if (!user) redirect("/login");
  const post = await getPost(postId, user);
  if (!post) notFound();
  if (post.userId !== user.id) redirect(`/board/${post.id}`);

  const template =
    post.kind === "template" ? await getTemplateForPost(post.id) : null;
  const collections = template ? await listCollections(user) : [];
  const latest = template?.versions[0] ?? null;
  const previousFiles =
    template && latest
      ? template.files.map((file) => `${latest.sourcePath}${file.path}`)
      : [];
  const presentFiles = latest
    ? await filesStillPresent(user.loginName, latest.sourcePath, previousFiles)
    : [];

  return (
    <div className="bg-background min-h-screen p-4 sm:p-6">
      <main className="mx-auto max-w-3xl space-y-8">
        <div className="space-y-1">
          <Link
            href={`/board/${post.id}`}
            className="text-xs text-primary hover:underline"
          >
            ← 글로 돌아가기
          </Link>
          <h1 className="text-2xl font-bold">글 고치기</h1>
        </div>
        <EditPostForm postId={post.id} title={post.title} body={post.body} />
        {template && (
          <section className="space-y-4 border-2 border-line p-4">
            <div className="space-y-1">
              <h2 className="text-lg font-bold">새 버전을 올리는 곳</h2>
              <p className="text-sm text-muted-foreground">
                새 버전이 나오면 이 템플릿을 설치한 사이트에 알려요. 설치한
                사람이 업데이트하면 템플릿이 설치한 파일만 바뀌어요.
              </p>
            </div>
            <SourceForm
              templateId={template.id}
              owner={user.loginName}
              source={template.source}
              repository={template.github?.repository ?? ""}
              branch={template.github?.ref.replace(/^refs\/heads\//, "") ?? ""}
              path={template.github?.path ?? null}
            />
          </section>
        )}
        {template && (
          <section className="space-y-4 border-2 border-line p-4">
            <div className="space-y-1">
              <h2 className="text-lg font-bold">미리보기 이미지</h2>
              <p className="text-sm text-muted-foreground">
                {template.customPreview
                  ? "올린 이미지가 게시판과 글에 보여요. 되돌리면 버전마다 찍는 파일의 스크린샷이 보여요."
                  : "지금은 버전마다 파일의 스크린샷을 찍어요. 사이트의 데이터나 로그인이 있어야 보이는 템플릿은 화면을 담은 이미지를 올려 주세요."}
                {template.source === "github" &&
                  " 워크플로에서 preview로 이미지를 정해도 돼요."}
              </p>
            </div>
            <PreviewForm
              templateId={template.id}
              current={template.previewUrl}
              custom={template.customPreview}
            />
          </section>
        )}
        {template && template.source === "site" && (
          <section className="space-y-4 border-2 border-line p-4">
            <div className="space-y-1">
              <h2 className="text-lg font-bold">새 버전 올리기</h2>
              <p className="text-sm text-muted-foreground">
                {latest
                  ? `지금은 v${latest.version}이에요. 체크한 파일의 지금 내용으로 v${latest.version + 1}을(를) 만들어요.`
                  : "체크한 파일의 지금 내용으로 첫 버전을 만들어요."}{" "}
                설치한 사람은 알림을 받고, 설치한 템플릿에서 직접 업데이트해요.
              </p>
            </div>
            <NewVersionForm
              templateId={template.id}
              postId={post.id}
              initialFiles={presentFiles}
              missingFiles={previousFiles.filter(
                (path) => !presentFiles.includes(path),
              )}
              collections={collections.map((c) => c.name)}
              initialCollections={latest?.collections.map((c) => c.name) ?? []}
            />
          </section>
        )}
      </main>
    </div>
  );
}
