"use client";

import { useEffect, useId, useMemo } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  formatBytes,
  TEMPLATE_PREVIEW_MAX_BYTES,
  TEMPLATE_PREVIEW_TYPES,
} from "@/lib/board/constants";

// Picks a template's own preview image: shown at 4:3 from the top, in
// place of the screenshot of its files. `current` is what the template
// shows now, kept while nothing is picked.
export function PreviewPicker({
  value,
  onChange,
  current,
}: {
  value: File | null;
  onChange: (file: File | null) => void;
  current?: string | null;
}) {
  const id = useId();
  const picked = useMemo(
    () => (value ? URL.createObjectURL(value) : null),
    [value],
  );
  useEffect(
    () => () => {
      if (picked) URL.revokeObjectURL(picked);
    },
    [picked],
  );
  const shown = picked ?? current ?? null;

  function pick(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!file) return;
    if (!(TEMPLATE_PREVIEW_TYPES as readonly string[]).includes(file.type)) {
      toast.error("PNG, JPEG, WebP 이미지만 올릴 수 있어요.");
      return;
    }
    if (file.size > TEMPLATE_PREVIEW_MAX_BYTES) {
      toast.error(
        `미리보기 이미지는 ${formatBytes(TEMPLATE_PREVIEW_MAX_BYTES)}까지 올릴 수 있어요.`,
      );
      return;
    }
    onChange(file);
  }

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
      <div className="relative aspect-[4/3] w-full shrink-0 overflow-hidden border border-border bg-muted sm:w-48">
        {shown ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={shown}
            alt="미리보기"
            className="absolute inset-0 h-full w-full object-cover object-top"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center p-2 text-center text-xs text-muted-foreground">
            파일의 스크린샷
          </div>
        )}
      </div>
      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          <Button asChild type="button" variant="outline" size="sm">
            <label htmlFor={id} className="cursor-pointer">
              {value ? "다른 이미지 고르기" : "이미지 고르기"}
            </label>
          </Button>
          {value && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onChange(null)}
            >
              빼기
            </Button>
          )}
        </div>
        <input
          id={id}
          type="file"
          accept={TEMPLATE_PREVIEW_TYPES.join(",")}
          onChange={pick}
          className="sr-only"
        />
        <p className="text-xs text-muted-foreground">
          PNG, JPEG, WebP, {formatBytes(TEMPLATE_PREVIEW_MAX_BYTES)}까지.
          4:3(예: 1280×960)으로 위에서부터 보여요.
        </p>
      </div>
    </div>
  );
}
