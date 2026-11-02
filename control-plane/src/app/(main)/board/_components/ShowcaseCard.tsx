import Link from "next/link";
import { ArrowUpRight, Heart, MessageSquare } from "lucide-react";
import type { PostSummary } from "@/lib/board/posts";
import { getHomepageUrl } from "@/lib/site-urls";
import { PostTitle } from "./PostTitle";
import { Thumbnail, postThumbnailUrl } from "./Thumbnail";
import { formatRelative } from "./format";

// A 사이트 자랑 post as a browser window: the site's address, which opens the
// site, over its screenshot. The rest of the card opens the post.
export function ShowcaseCard({ post }: { post: PostSummary }) {
  const url = getHomepageUrl(post.authorLoginName);
  return (
    <article className="lift relative flex flex-col border-2 border-line bg-card">
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="relative z-10 flex min-h-11 items-center justify-between gap-2 border-b-2 border-line bg-secondary px-3 font-mono text-xs text-secondary-foreground hover:bg-accent hover:text-accent-foreground"
      >
        <span className="truncate">{new URL(url).host}</span>
        <ArrowUpRight size={14} className="shrink-0" aria-hidden="true" />
        <span className="sr-only">사이트 열기</span>
      </a>
      <Thumbnail
        url={postThumbnailUrl(post)}
        alt=""
        className="border-0 border-b-2 border-b-line"
        sizes="(max-width: 640px) 100vw, (max-width: 1280px) 50vw, 420px"
      />
      <div className="flex flex-1 flex-col gap-2 p-4">
        {/* The title's link covers the whole card. */}
        <Link
          href={`/board/${post.id}`}
          className="break-words text-lg font-bold leading-snug text-foreground after:absolute after:inset-0"
        >
          <PostTitle title={post.title} />
        </Link>
        {post.excerpt && (
          <p className="line-clamp-2 text-sm leading-relaxed text-muted-foreground">
            {post.excerpt}
          </p>
        )}
        <div className="mt-auto flex items-center gap-3 pt-1 text-xs text-muted-foreground">
          <span className="min-w-0 truncate font-mono font-medium text-foreground">
            {post.authorLoginName}
          </span>
          <span className="shrink-0">{formatRelative(post.createdAt)}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1">
            <Heart size={13} aria-hidden="true" />
            <span className="sr-only">좋아요</span>
            {post.likeCount}
          </span>
          <span className="flex shrink-0 items-center gap-1">
            <MessageSquare size={13} aria-hidden="true" />
            <span className="sr-only">답글</span>
            {post.replyCount}
          </span>
        </div>
      </div>
    </article>
  );
}
