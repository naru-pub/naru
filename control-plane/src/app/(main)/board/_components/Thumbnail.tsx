import Image from "next/image";
import { getRenderedSiteUrl } from "@/lib/site-urls";
import { templatePreviewUrl } from "@/lib/board/preview";
import type { PostSummary } from "@/lib/board/posts";

// The picture beside a post: a template's preview, or the current screenshot
// of the author's site for a 사이트 자랑 post. Other kinds have none.
export function postThumbnailUrl(post: PostSummary): string | null {
  if (post.template) {
    return templatePreviewUrl({
      id: post.template.id,
      customPreviewAt: post.template.customPreviewAt,
      version: post.template.version,
      renderedAt: post.template.previewRenderedAt,
    });
  }
  if (post.kind === "site" && post.authorSiteRenderedAt) {
    return getRenderedSiteUrl(post.authorLoginName, post.authorSiteRenderedAt);
  }
  return null;
}

export function Thumbnail({
  url,
  alt,
  className,
  fill = false,
}: {
  url: string | null;
  alt: string;
  className?: string;
  // On wide screens, grow to the container's height. The 4:3 picture keeps
  // its shape and is centered in the extra space, so nothing is cropped.
  fill?: boolean;
}) {
  return (
    <div
      className={`flex items-center overflow-hidden border border-border bg-muted ${fill ? "lg:h-full" : ""} ${className ?? ""}`}
    >
      <div className="relative aspect-[4/3] w-full">
        {url ? (
          <Image
            src={url}
            alt={alt}
            fill
            sizes="(max-width: 640px) 100vw, 320px"
            className="object-cover object-top"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
            미리보기 준비 중
          </div>
        )}
      </div>
    </div>
  );
}
