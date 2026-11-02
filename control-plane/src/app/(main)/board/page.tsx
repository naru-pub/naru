import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { validateRequest } from "@/lib/auth";
import { type PostSort } from "@/lib/board/constants";
import { listPosts } from "@/lib/board/posts";
import { countUnreadNotifications } from "@/lib/board/replies";
import { ShowcaseCard } from "./_components/ShowcaseCard";

export const metadata: Metadata = {
  title: "자랑 · 나루",
  description: "나루 사람들이 만든 사이트를 구경해 보세요.",
};

const SORT_LABELS: Record<PostSort, string> = {
  activity: "최근 활동순",
  new: "새 글순",
  applied: "적용 많은순",
};
const SORTS: PostSort[] = ["activity", "new"];

function boardHref(sort: PostSort, page = 1) {
  const params = new URLSearchParams();
  if (sort !== "activity") params.set("sort", sort);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `/board?${query}` : "/board";
}

export default async function BoardPage({
  searchParams,
}: {
  searchParams: Promise<{
    kind?: string;
    sort?: string;
    page?: string;
    database?: string;
  }>;
}) {
  const params = await searchParams;
  // Templates moved to /templates; older links and the database docs still
  // come here, with the filters that page reads.
  if (params.kind === "template") {
    const { kind: _kind, ...rest } = params;
    const query = new URLSearchParams(rest).toString();
    redirect(query ? `/templates?${query}` : "/templates");
  }
  const sort = SORTS.includes(params.sort as PostSort)
    ? (params.sort as PostSort)
    : "activity";
  const page = Math.max(1, Number.parseInt(params.page ?? "1", 10) || 1);

  const { user } = await validateRequest();
  const [{ posts, hasMore }, unread] = await Promise.all([
    listPosts({ kind: "site", sort, page }),
    user ? countUnreadNotifications(user.id) : null,
  ]);

  return (
    <div className="bg-background min-h-screen px-4 pb-16 pt-8 sm:px-6">
      <div className="mx-auto max-w-7xl space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-3xl font-bold text-foreground">자랑</h1>
            <p className="text-sm text-muted-foreground">
              나루 사람들이 만든 사이트를 구경해 보세요.
            </p>
          </div>
          <Button asChild>
            <Link href="/board/new">
              <Plus aria-hidden="true" />내 사이트 자랑하기
            </Link>
          </Button>
        </div>

        {unread && unread.count > 0 && (
          <Link
            href="/board/notifications"
            className="block border-2 border-primary bg-primary/5 px-4 py-3 text-sm hover:bg-primary/10"
          >
            <span className="font-bold text-primary">
              {unread.versions === 0
                ? `새 답글 ${unread.count}개`
                : `새 알림 ${unread.count}개`}{" "}
              →
            </span>
            {unread.replies > 0 && (
              <span className="ml-2 text-xs text-muted-foreground">
                {unread.from.join(", ")} 님이 답글을 달았어요
              </span>
            )}
            {unread.versions > 0 && (
              <span className="ml-2 text-xs text-muted-foreground">
                설치한 템플릿의 새 버전이 {unread.versions}개 나왔어요
              </span>
            )}
          </Link>
        )}

        <nav
          aria-label="정렬"
          className="flex gap-5 border-b-2 border-line text-sm"
        >
          {SORTS.map((value) => (
            <Link
              key={value}
              href={boardHref(value)}
              aria-current={value === sort ? "true" : undefined}
              className={`-mb-0.5 flex min-h-11 items-center border-b-[3px] ${
                value === sort
                  ? "border-primary font-bold text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {SORT_LABELS[value]}
            </Link>
          ))}
        </nav>

        {posts.length === 0 ? (
          <p className="border-2 border-line bg-card p-10 text-center text-sm text-muted-foreground">
            아직 자랑한 사이트가 없어요. 첫 번째로 자랑해 보세요!
          </p>
        ) : (
          <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
            {posts.map((post) => (
              <ShowcaseCard key={post.id} post={post} />
            ))}
          </div>
        )}

        {(page > 1 || hasMore) && (
          <div className="flex justify-center gap-4 pt-2 text-sm">
            {page > 1 && (
              <Link
                href={boardHref(sort, page - 1)}
                className="text-muted-foreground hover:text-foreground"
              >
                ← 이전
              </Link>
            )}
            <span className="text-foreground">{page}</span>
            {hasMore && (
              <Link
                href={boardHref(sort, page + 1)}
                className="text-muted-foreground hover:text-foreground"
              >
                다음 →
              </Link>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
