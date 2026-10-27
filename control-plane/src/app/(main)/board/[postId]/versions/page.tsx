import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { validateRequest } from "@/lib/auth";
import { getPost } from "@/lib/board/posts";
import { getTemplateForPost } from "@/lib/board/templates";
import { formatDate } from "../../_components/format";
import { PostTitle } from "../../_components/PostTitle";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ postId: string }>;
}): Promise<Metadata> {
  const { postId } = await params;
  const post = ID.test(postId) ? await getPost(postId, null) : null;
  if (!post) return { title: "게시판 · 나루" };
  return { title: `${post.title} 버전 기록 · 나루 게시판` };
}

// A template's versions, newest first, with their changelogs.
export default async function VersionsPage({
  params,
}: {
  params: Promise<{ postId: string }>;
}) {
  const { postId } = await params;
  if (!ID.test(postId)) notFound();

  const { user } = await validateRequest();
  const post = await getPost(postId, user);
  if (!post || post.kind !== "template") notFound();
  const template = await getTemplateForPost(post.id);
  if (!template) notFound();

  const githubUrl = template.github
    ? `https://github.com/${template.github.repository}`
    : null;

  return (
    <div className="bg-background min-h-screen p-4 sm:p-6">
      <main className="mx-auto max-w-4xl space-y-6">
        <nav
          aria-label="위치"
          className="flex flex-wrap gap-2 text-xs text-muted-foreground"
        >
          <Link href="/board" className="text-primary hover:underline">
            게시판
          </Link>
          <span>/</span>
          <Link
            href={`/board/${post.id}`}
            className="text-primary hover:underline"
          >
            <PostTitle title={post.title} />
          </Link>
        </nav>

        <section className="border-2 border-line bg-card">
          <h1 className="border-b-2 border-line bg-secondary px-4 py-3 font-bold">
            버전 기록
          </h1>
          {template.versions.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              아직 버전이 없어요.
            </p>
          ) : (
            <ol className="divide-y divide-border">
              {template.versions.map((version) => (
                <li key={version.id} className="space-y-1 p-4 text-sm">
                  <div className="font-bold">
                    v{version.version}{" "}
                    <span className="text-xs font-normal text-muted-foreground">
                      {formatDate(version.createdAt)}
                      {version.githubSha && githubUrl && (
                        <>
                          {" · "}
                          <a
                            href={`${githubUrl}/commit/${version.githubSha}`}
                            className="font-mono underline"
                          >
                            {version.githubSha.slice(0, 7)}
                          </a>
                        </>
                      )}
                      {version.newMigrations.length > 0 &&
                        ` · 마이그레이션 ${version.newMigrations.length}개`}
                    </span>
                  </div>
                  {version.changelog && (
                    <p className="whitespace-pre-wrap text-muted-foreground">
                      {version.changelog}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          )}
        </section>
      </main>
    </div>
  );
}
