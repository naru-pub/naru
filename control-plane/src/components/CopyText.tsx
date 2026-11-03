"use client";

import { toast } from "sonner";
import { Button } from "@/components/ui/button";

// A 복사 button for text shown beside it: an address, a prompt to paste.
export function CopyText({
  text,
  label,
  className,
}: {
  text: string;
  /** What the button copies, for a screen reader. */
  label: string;
  className?: string;
}) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("복사되었습니다.");
    } catch {
      toast.error("복사에 실패했습니다.");
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={copy}
      aria-label={`${label} 복사`}
      className={className}
    >
      복사
    </Button>
  );
}
