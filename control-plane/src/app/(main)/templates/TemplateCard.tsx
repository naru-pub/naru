import Link from "next/link";
import { Download } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { PostSummary } from "@/lib/board/posts";
import { PostTitle } from "../board/_components/PostTitle";
import { Thumbnail, postThumbnailUrl } from "../board/_components/Thumbnail";

export function tagHref(tag: string) {
  return `/templates?tag=${encodeURIComponent(tag)}`;
}

// A template on the store's shelves (`rank` on a ranked one), or with its
// description and what it needs in the full list (`detailed`).
export function TemplateCard({
  post,
  rank,
  detailed = false,
}: {
  post: PostSummary;
  rank?: number;
  detailed?: boolean;
}) {
  const template = post.template;
  return (
    <li className="lift relative flex flex-col border-2 border-line bg-card">
      {rank !== undefined && (
        <span className="absolute -left-0.5 -top-0.5 z-10 bg-foreground px-2 py-0.5 font-mono text-xs font-semibold text-background">
          {String(rank).padStart(2, "0")}
        </span>
      )}
      <Link href={`/board/${post.id}`} tabIndex={-1} aria-hidden="true">
        <Thumbnail
          url={postThumbnailUrl(post)}
          alt=""
          className="border-0 border-b-2 border-b-line"
        />
      </Link>
      <div className="flex flex-1 flex-col gap-1.5 p-3">
        <Link
          href={`/board/${post.id}`}
          className="block truncate font-bold text-foreground underline-offset-4 hover:underline"
        >
          <PostTitle title={post.title} />
        </Link>
        {detailed && post.excerpt && (
          <p className="line-clamp-2 text-sm leading-relaxed text-muted-foreground">
            {post.excerpt}
          </p>
        )}
        <div className="mt-auto flex items-center justify-between gap-2 pt-1 text-xs text-muted-foreground">
          <span className="truncate font-mono">{post.authorLoginName}</span>
          <span className="flex shrink-0 items-center gap-1 font-semibold text-link">
            <Download size={12} aria-hidden="true" />
            {template?.applyCount ?? 0}회 적용
          </span>
        </div>
        {((detailed && template?.usesDatabase) ||
          (template?.tags.length ?? 0) > 0) && (
          <div className="flex flex-wrap items-center gap-1 pt-1 text-xs">
            {detailed && template?.usesDatabase && (
              <Badge variant="link">데이터베이스</Badge>
            )}
            {template?.tags.map((tag) => (
              <Link
                key={tag}
                href={tagHref(tag)}
                className="bg-accent px-1.5 py-1 text-accent-foreground hover:underline"
              >
                {tag}
              </Link>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}
