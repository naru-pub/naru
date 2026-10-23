"use client";

import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

export default function CopyPrompt({ prompt }: { prompt: string }) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(prompt);
      toast.success("안내문이 복사되었습니다. AI 대화창에 붙여 넣으세요.");
    } catch {
      toast.error("복사에 실패했습니다. 아래 글을 직접 선택해 복사하세요.");
    }
  }
  return (
    <Button onClick={copy}>
      <Copy className="size-4" />
      안내문 복사하기
    </Button>
  );
}
