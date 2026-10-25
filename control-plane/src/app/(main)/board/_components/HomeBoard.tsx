import Link from "next/link";
import { Download, MessageSquare } from "lucide-react";
import { PostTitle } from "./PostTitle";
import { Thumbnail } from "./Thumbnail";

// What the front page shows of a post.
export interface HomePost {
  id: string;
  title: string;
  authorLoginName: string;
  replyCount: number;
  applyCount: number | null;
  thumbnailUrl: string | null;
}

// The front page's board card: the newest templates and showcased sites,
// as pictures in a grid.
export function HomeBoard({ posts }: { posts: HomePost[] }) {
  return (
    <section className="min-w-0 flex-1 flex flex-col border-2 border-line bg-card">
      <div className="flex items-end justify-between gap-3 border-b border-border px-2 sm:px-4">
        <h2 className="px-2 py-3 font-bold">템플릿 / 사이트 자랑</h2>
        <Link
          href="/board"
          className="mb-3 shrink-0 whitespace-nowrap text-sm font-medium text-link underline-offset-4 hover:underline"
        >
          더 보기 →
        </Link>
      </div>
      <div className="p-4 sm:p-6 flex-1 flex flex-col">
        <BoardPosts posts={posts} />
      </div>
    </section>
  );
}

function BoardPosts({ posts }: { posts: HomePost[] }) {
  if (posts.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 py-10 text-center">
        <p className="text-muted-foreground">
          아직 공유된 템플릿이나 사이트가 없어요.
        </p>
        <Link
          href="/board/new?kind=template"
          className="text-sm font-medium text-link underline-offset-4 hover:underline"
        >
          내 사이트를 첫 템플릿으로 공유해 보세요 →
        </Link>
      </div>
    );
  }
  return (
    <div className="grid flex-1 grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 lg:auto-rows-fr">
      {posts.map((post) => (
        <article
          key={post.id}
          className="lift relative border-2 border-line bg-card flex flex-col"
        >
          <Thumbnail
            url={post.thumbnailUrl}
            alt=""
            className="border-0 border-b-2 border-b-line lg:flex-1"
            fill
          />
          <div className="p-3 space-y-1">
            {/* The title's link covers the whole card. */}
            <Link
              href={`/board/${post.id}`}
              className="block truncate font-bold text-foreground after:absolute after:inset-0"
            >
              <PostTitle title={post.title} />
            </Link>
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="truncate font-mono">{post.authorLoginName}</span>
              {post.applyCount !== null ? (
                <span className="flex shrink-0 items-center gap-1 font-semibold text-link">
                  <Download size={12} aria-hidden="true" />
                  {post.applyCount}회 적용
                </span>
              ) : (
                <span className="flex shrink-0 items-center gap-1">
                  <MessageSquare size={12} aria-hidden="true" />
                  <span className="sr-only">답글</span>
                  {post.replyCount}
                </span>
              )}
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}
