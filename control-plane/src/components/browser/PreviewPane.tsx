"use client";

import { useState } from "react";
import { ExternalLink, RotateCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * The published page beside the editor. It reloads whenever `version`
 * changes (each save), so CSS and scripts the page uses show their edits
 * too. Pages are served with max-age=0 and purged on save, so a reload
 * fetches the saved file.
 */
export default function PreviewPane({
  url,
  version,
  onClose,
}: {
  url: string | null;
  version: number;
  onClose: () => void;
}) {
  const [manual, setManual] = useState(0);

  return (
    <div className="flex h-full min-w-0 flex-col bg-card">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border bg-secondary px-2">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {url ?? "미리 볼 HTML 파일을 여세요"}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={() => setManual((n) => n + 1)}
          disabled={!url}
          title="새로고침"
          aria-label="미리보기 새로고침"
        >
          <RotateCw />
        </Button>
        {url && (
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            asChild
            title="새 탭에서 열기"
          >
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="새 탭에서 열기"
            >
              <ExternalLink />
            </a>
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={onClose}
          title="미리보기 닫기"
          aria-label="미리보기 닫기"
        >
          <X />
        </Button>
      </div>
      {url ? (
        <iframe
          key={`${url}#${version}#${manual}`}
          src={url}
          title="미리보기"
          className="min-h-0 w-full flex-1 bg-white"
        />
      ) : (
        <div className="flex flex-1 items-center justify-center p-4 text-center text-sm text-muted-foreground">
          HTML 파일을 열면 여기에 페이지가 표시됩니다
        </div>
      )}
    </div>
  );
}
