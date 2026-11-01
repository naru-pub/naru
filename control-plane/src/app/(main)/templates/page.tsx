import type { Metadata } from "next";
import Link from "next/link";
import { Download, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { validateRequest } from "@/lib/auth";
import { listPosts, type PostSummary } from "@/lib/board/posts";
import { installCounts } from "@/lib/board/updates";
import { PostTitle } from "../board/_components/PostTitle";
import { Thumbnail, postThumbnailUrl } from "../board/_components/Thumbnail";

export const metadata: Metadata = {
  title: "템플릿 · 나루",
  description: "내 사이트에 버튼 한 번으로 적용하는 나루 템플릿.",
};

// Browsing templates. Each is a board post (/board/[postId]), where it is
// applied and talked about; this page only lists them as pictures.

type Sort = "applied" | "new";

const SORT_LABELS: Record<Sort, string> = {
  applied: "적용 많은순",
  new: "새 글순",
};

interface Filters {
  database: boolean;
  sort: Sort;
}

function templatesHref({ database, sort }: Filters, page = 1) {
  const params = new URLSearchParams();
  if (database) params.set("database", "1");
  if (sort !== "applied") params.set("sort", sort);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `/templates?${query}` : "/templates";
}

function filterClass(active: boolean) {
  return active
    ? "font-bold text-foreground"
    : "text-muted-foreground hover:text-foreground";
}

export default async function TemplatesPage({
  searchParams,
}: {
  searchParams: Promise<{
    database?: string;
    sort?: string;
    page?: string;
  }>;
}) {
  const params = await searchParams;
  const filters: Filters = {
    database: params.database === "1",
    sort: params.sort === "new" ? "new" : "applied",
  };
  const page = Math.max(1, Number.parseInt(params.page ?? "1", 10) || 1);

  const { user } = await validateRequest();
  const [{ posts, hasMore }, installs] = await Promise.all([
    listPosts({
      kind: "template",
      sort: filters.sort,
      page,
      usesDatabase: filters.database,
    }),
    user ? installCounts(user.id) : null,
  ]);

  return (
    <div className="bg-background min-h-screen p-4 sm:p-6">
      <div className="mx-auto max-w-7xl space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-3xl font-bold text-foreground">템플릿</h1>
            <p className="text-sm text-muted-foreground">
              다른 사람이 만든 사이트를 버튼 한 번으로 내 사이트에 적용해
              보세요.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            {installs && installs.installed > 0 && (
              <Link
                href="/templates/installed"
                className="text-sm text-primary underline-offset-4 hover:underline"
              >
                설치한 템플릿 {installs.installed}개
                {installs.updatable > 0 && ` · 새 버전 ${installs.updatable}개`}{" "}
                →
              </Link>
            )}
            <Button asChild>
              <Link href="/board/new?kind=template">
                <Plus aria-hidden="true" />
                템플릿 공유하기
              </Link>
            </Button>
          </div>
        </div>

        <section className="border-2 border-line bg-card">
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-border px-4 py-2 text-xs">
            <nav aria-label="필터" className="flex flex-wrap gap-3">
              <Link
                href={templatesHref({
                  ...filters,
                  database: !filters.database,
                })}
                aria-pressed={filters.database}
                className={filterClass(filters.database)}
              >
                {filters.database ? "✓ " : ""}데이터베이스 사용
              </Link>
            </nav>
            <nav aria-label="정렬" className="flex gap-3">
              {(["applied", "new"] as const).map((value) => (
                <Link
                  key={value}
                  href={templatesHref({ ...filters, sort: value })}
                  aria-current={value === filters.sort ? "true" : undefined}
                  className={filterClass(value === filters.sort)}
                >
                  {SORT_LABELS[value]}
                </Link>
              ))}
            </nav>
          </div>

          {posts.length === 0 ? (
            <p className="p-10 text-center text-sm text-muted-foreground">
              {filters.database
                ? "조건에 맞는 템플릿이 없어요."
                : "아직 템플릿이 없어요. 첫 템플릿을 공유해 보세요!"}
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2 sm:p-6 lg:grid-cols-3 xl:grid-cols-4">
              {posts.map((post) => (
                <TemplateCard key={post.id} post={post} />
              ))}
            </div>
          )}

          {(page > 1 || hasMore) && (
            <div className="flex justify-center gap-4 border-t border-border p-4 text-sm">
              {page > 1 && (
                <Link
                  href={templatesHref(filters, page - 1)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  ← 이전
                </Link>
              )}
              <span className="text-foreground">{page}</span>
              {hasMore && (
                <Link
                  href={templatesHref(filters, page + 1)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  다음 →
                </Link>
              )}
            </div>
          )}
        </section>

        <section className="flex flex-wrap items-center justify-between gap-3 border-2 border-line bg-card p-4">
          <div className="space-y-1">
            <h2 className="font-bold">템플릿을 팔아 보고 싶나요?</h2>
            <p className="text-sm text-muted-foreground">
              지금은 모든 템플릿이 무료예요. 유료 판매에 관심이 있다면 알려
              주세요.
            </p>
          </div>
          <Button asChild variant="outline">
            <Link href="/templates/sell">판매 관심 알리기</Link>
          </Button>
        </section>
      </div>
    </div>
  );
}

function TemplateCard({ post }: { post: PostSummary }) {
  return (
    <article className="lift relative flex flex-col border-2 border-line bg-card">
      <Thumbnail
        url={postThumbnailUrl(post)}
        alt=""
        className="border-0 border-b-2 border-b-line"
      />
      <div className="space-y-1 p-3">
        {/* The title's link covers the whole card. */}
        <Link
          href={`/board/${post.id}`}
          className="block truncate font-bold text-foreground after:absolute after:inset-0"
        >
          <PostTitle title={post.title} />
        </Link>
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="truncate font-mono">{post.authorLoginName}</span>
          <span className="flex shrink-0 items-center gap-1 font-semibold text-link">
            <Download size={12} aria-hidden="true" />
            {post.template?.applyCount ?? 0}회 적용
          </span>
        </div>
      </div>
    </article>
  );
}
