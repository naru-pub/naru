import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { validateRequest } from "@/lib/auth";
import type { PostSort } from "@/lib/board/constants";
import {
  countPosts,
  countTemplates,
  listLatestPosts,
  listPopularTemplatePosts,
  listPosts,
  listTemplateTags,
  type PostSummary,
} from "@/lib/board/posts";
import { normalizeTag } from "@/lib/board/tags";
import { installCounts } from "@/lib/board/updates";
import { TemplateCard, tagHref } from "./TemplateCard";

export const metadata: Metadata = {
  title: "템플릿 · 나루",
  description: "내 사이트에 버튼 한 번으로 적용하는 나루 템플릿.",
};

// The template store: shelves at first, the full list once something is
// searched, filtered or sorted. Each template is a board post
// (/board/[postId]), where it is applied and talked about.

const SHELF_SIZE = 4;
const SIDEBAR_TAGS = 16;

type Sort = Extract<PostSort, "applied" | "new">;
type Kind = "database" | "files" | null;

const SORT_LABELS: Record<Sort, string> = {
  applied: "적용 많은순",
  new: "새로 나온순",
};
const KIND_LABELS: Record<Exclude<Kind, null>, string> = {
  database: "데이터베이스 사용",
  files: "파일만",
};

interface Filters {
  search: string;
  tag: string | null;
  kind: Kind;
  sort: Sort;
}

// Always names a sort, so that even the plainest list isn't the shelves.
function listHref({ search, tag, kind, sort }: Filters, page = 1) {
  const params = new URLSearchParams();
  if (search) params.set("q", search);
  if (tag) params.set("tag", tag);
  if (kind === "database") params.set("database", "1");
  if (kind === "files") params.set("files", "1");
  params.set("sort", sort);
  if (page > 1) params.set("page", String(page));
  return `/templates?${params}`;
}

const ALL: Filters = { search: "", tag: null, kind: null, sort: "applied" };

export default async function TemplatesPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    tag?: string;
    database?: string;
    files?: string;
    sort?: string;
    page?: string;
  }>;
}) {
  const params = await searchParams;
  const filters: Filters = {
    search: typeof params.q === "string" ? params.q.trim().slice(0, 100) : "",
    tag:
      typeof params.tag === "string" ? normalizeTag(params.tag) || null : null,
    kind:
      params.database === "1"
        ? "database"
        : params.files === "1"
          ? "files"
          : null,
    sort: params.sort === "new" ? "new" : "applied",
  };
  const page = Math.max(1, Number.parseInt(params.page ?? "1", 10) || 1);
  const browsing =
    !!filters.search ||
    !!filters.tag ||
    !!filters.kind ||
    params.sort !== undefined ||
    page > 1;

  const { user } = await validateRequest();
  const [counts, tags, installs] = await Promise.all([
    countTemplates(),
    listTemplateTags(SIDEBAR_TAGS),
    user ? installCounts(user.id) : null,
  ]);
  const Heading = browsing ? "p" : "h1";

  return (
    <div className="bg-background min-h-screen">
      <div className="bg-[hsl(225_17%_8%)] text-white">
        <form
          action="/templates"
          role="search"
          className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3.5 sm:px-6"
        >
          <Heading className="text-xl font-bold">템플릿</Heading>
          <div className="flex min-w-0 flex-[1_1_280px] border-2 border-foreground bg-card text-foreground">
            <label htmlFor="template-search" className="sr-only">
              템플릿 검색
            </label>
            <input
              id="template-search"
              type="search"
              name="q"
              defaultValue={filters.search}
              placeholder={`템플릿 ${counts.all}개에서 검색`}
              className="h-11 min-w-0 flex-1 bg-transparent px-3.5 text-[15px] placeholder:text-muted-foreground"
            />
            <Button
              type="submit"
              className="h-11 min-w-[72px] shrink-0 border-0 shadow-none"
            >
              검색
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <Link
              href="/templates/sell"
              className="flex min-h-11 items-center gap-1 text-sm font-medium text-white underline underline-offset-4 hover:no-underline"
            >
              템플릿을 판매하고 싶나요? <span aria-hidden="true">→</span>
            </Link>
            <Link
              href="/board/new?kind=template"
              className="flex min-h-11 items-center border-2 border-white px-4 text-sm font-bold text-white hover:bg-white hover:text-black"
            >
              템플릿 등록하기
            </Link>
          </div>
        </form>
      </div>

      <div className="mx-auto grid max-w-7xl gap-x-10 gap-y-6 px-4 pb-16 pt-6 sm:px-6 lg:grid-cols-[14rem_minmax(0,1fr)]">
        <aside className="min-w-0 space-y-6 text-sm">
          <nav aria-label="둘러보기">
            <h2 className="mb-1.5 hidden text-xs font-bold text-muted-foreground lg:block">
              둘러보기
            </h2>
            <ul className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:-mx-6 sm:px-6 lg:mx-0 lg:block lg:overflow-visible lg:p-0 [&::-webkit-scrollbar]:hidden">
              <SideLink href="/templates" active={!browsing}>
                스토어 홈
              </SideLink>
              <SideLink
                href={listHref(ALL)}
                active={
                  browsing && !filters.kind && !filters.tag && !filters.search
                }
                count={counts.all}
              >
                모든 템플릿
              </SideLink>
              <SideLink
                href={listHref({ ...filters, kind: "database" })}
                active={filters.kind === "database"}
                count={counts.database}
              >
                {KIND_LABELS.database}
              </SideLink>
              <SideLink
                href={listHref({ ...filters, kind: "files" })}
                active={filters.kind === "files"}
                count={counts.all - counts.database}
              >
                {KIND_LABELS.files}
              </SideLink>
              {installs && installs.installed > 0 && (
                <SideLink
                  href="/templates/installed"
                  count={installs.installed}
                  badge={installs.updatable}
                >
                  설치한 템플릿
                </SideLink>
              )}
            </ul>
          </nav>

          {tags.length > 0 && (
            <nav
              aria-label="태그"
              className="lg:border-t-2 lg:border-line lg:pt-4"
            >
              <h2 className="mb-2.5 hidden text-xs font-bold text-muted-foreground lg:block">
                태그
              </h2>
              <ul className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:-mx-6 sm:px-6 lg:mx-0 lg:flex-wrap lg:overflow-visible lg:p-0 [&::-webkit-scrollbar]:hidden">
                {tags.map(({ tag, count }) => {
                  const active = tag === filters.tag;
                  return (
                    <li key={tag} className="shrink-0">
                      <Link
                        href={
                          active
                            ? listHref({ ...filters, tag: null })
                            : browsing
                              ? listHref({ ...filters, tag })
                              : tagHref(tag)
                        }
                        aria-current={active ? "true" : undefined}
                        className={`inline-flex min-h-9 items-center gap-1.5 border-[1.5px] border-line px-2.5 text-[13px] ${active ? "bg-primary font-bold text-primary-foreground" : "bg-card text-foreground hover:bg-accent"}`}
                      >
                        {tag}
                        <span
                          className={`font-mono text-xs ${active ? "" : "text-muted-foreground"}`}
                        >
                          {count}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </nav>
          )}
        </aside>

        <main className="min-w-0">
          {browsing ? (
            <TemplateList filters={filters} page={page} />
          ) : (
            <Shelves empty={counts.all === 0} />
          )}
        </main>
      </div>
    </div>
  );
}

function SideLink({
  href,
  active = false,
  count,
  badge,
  children,
}: {
  href: string;
  active?: boolean;
  count?: number;
  // New versions waiting.
  badge?: number;
  children: React.ReactNode;
}) {
  return (
    <li className="shrink-0">
      <Link
        href={href}
        aria-current={active ? "page" : undefined}
        className={`flex min-h-11 items-center justify-between gap-2 whitespace-nowrap px-2.5 hover:bg-accent ${active ? "bg-accent font-bold" : ""}`}
      >
        {children}
        <span className="flex items-center gap-1.5">
          {count !== undefined && (
            <span className="font-mono font-normal text-muted-foreground">
              {count}
            </span>
          )}
          {!!badge && (
            <span
              className="bg-primary px-1.5 font-mono text-xs leading-5 text-primary-foreground"
              aria-label={`새 버전 ${badge}개`}
            >
              {badge}
            </span>
          )}
        </span>
      </Link>
    </li>
  );
}

async function Shelves({ empty }: { empty: boolean }) {
  if (empty) {
    return (
      <p className="border-2 border-line bg-card p-10 text-center text-sm text-muted-foreground">
        아직 템플릿이 없어요. 첫 템플릿을 공유해 보세요!
      </p>
    );
  }
  const [popular, latest, database] = await Promise.all([
    listPopularTemplatePosts(SHELF_SIZE),
    listLatestPosts("template", SHELF_SIZE),
    listPosts({
      kind: "template",
      usesDatabase: true,
      sort: "applied",
      page: 1,
    }),
  ]);
  return (
    <div className="space-y-10">
      <Shelf title="인기 템플릿" href={listHref(ALL)} posts={popular} ranked />
      <Shelf
        title="새로 나온 템플릿"
        href={listHref({ ...ALL, sort: "new" })}
        posts={latest}
      />
      <Shelf
        title="데이터베이스를 쓰는 템플릿"
        href={listHref({ ...ALL, kind: "database" })}
        posts={database.posts.slice(0, SHELF_SIZE)}
      />
    </div>
  );
}

function Shelf({
  title,
  href,
  posts,
  ranked = false,
}: {
  title: string;
  href: string;
  posts: PostSummary[];
  ranked?: boolean;
}) {
  if (posts.length === 0) return null;
  const List = ranked ? "ol" : "ul";
  return (
    <section className="space-y-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b-2 border-line pb-2">
        <h2 className="text-xl font-bold tracking-tight">{title}</h2>
        <Link
          href={href}
          className="text-[13px] font-medium text-link underline-offset-4 hover:underline"
        >
          더 보기 →
        </Link>
      </div>
      <List className="grid grid-cols-[repeat(auto-fill,minmax(min(200px,100%),1fr))] gap-4">
        {posts.map((post, index) => (
          <TemplateCard
            key={post.id}
            post={post}
            rank={ranked ? index + 1 : undefined}
          />
        ))}
      </List>
    </section>
  );
}

async function TemplateList({
  filters,
  page,
}: {
  filters: Filters;
  page: number;
}) {
  const query = {
    kind: "template" as const,
    search: filters.search,
    tag: filters.tag,
    ...(filters.kind ? { usesDatabase: filters.kind === "database" } : {}),
  };
  const [{ posts, hasMore }, total] = await Promise.all([
    listPosts({ ...query, sort: filters.sort, page }),
    countPosts(query),
  ]);
  const title = filters.search
    ? `“${filters.search}” 검색 결과`
    : filters.tag
      ? `태그: ${filters.tag}`
      : filters.kind
        ? KIND_LABELS[filters.kind]
        : "모든 템플릿";
  return (
    <div className="space-y-3.5">
      <div className="flex flex-wrap items-center justify-between gap-x-4 border-b-2 border-line pb-1">
        <h1 className="min-w-0 break-words py-2 text-xl font-bold tracking-tight">
          {title}{" "}
          <span className="font-mono text-sm font-normal text-muted-foreground">
            {total}개
          </span>
        </h1>
        <nav aria-label="정렬" className="flex gap-4 text-[13px]">
          {(["applied", "new"] as const).map((sort) => (
            <Link
              key={sort}
              href={listHref({ ...filters, sort })}
              aria-current={sort === filters.sort ? "true" : undefined}
              className={`inline-flex min-h-11 items-center ${sort === filters.sort ? "font-bold text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              {SORT_LABELS[sort]}
            </Link>
          ))}
        </nav>
      </div>

      {posts.length === 0 ? (
        <div className="space-y-3 border-2 border-line bg-card p-10 text-center text-sm text-muted-foreground">
          <p>조건에 맞는 템플릿이 없어요.</p>
          <Link href={listHref(ALL)} className="text-link underline">
            모든 템플릿 보기
          </Link>
        </div>
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(260px,100%),1fr))] gap-4">
          {posts.map((post) => (
            <TemplateCard key={post.id} post={post} detailed />
          ))}
        </ul>
      )}

      {(page > 1 || hasMore) && (
        <div className="flex justify-center gap-4 p-4 text-sm">
          {page > 1 && (
            <Link
              href={listHref(filters, page - 1)}
              className="text-muted-foreground hover:text-foreground"
            >
              ← 이전
            </Link>
          )}
          <span className="text-foreground">{page}</span>
          {hasMore && (
            <Link
              href={listHref(filters, page + 1)}
              className="text-muted-foreground hover:text-foreground"
            >
              다음 →
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
