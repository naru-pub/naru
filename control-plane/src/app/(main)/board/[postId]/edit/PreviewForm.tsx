"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { boardRequest, uploadTemplatePreview } from "../../_components/api";
import { PreviewPicker } from "../../_components/PreviewPicker";

// The template's own preview image, set or replaced at any time, or removed
// to go back to the screenshots of its versions.
export function PreviewForm({
  templateId,
  current,
  custom,
}: {
  templateId: string;
  // What the template shows now.
  current: string | null;
  // Whether that is an image the author set.
  custom: boolean;
}) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!file) return;
    setBusy(true);
    try {
      await uploadTemplatePreview(templateId, file);
      setFile(null);
      toast.success("미리보기 이미지를 바꿨어요.");
      router.refresh();
    } catch (error: any) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await boardRequest(
        `/api/board/templates/${templateId}/preview`,
        "DELETE",
      );
      toast.success("파일의 스크린샷으로 되돌렸어요.");
      router.refresh();
    } catch (error: any) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <PreviewPicker value={file} onChange={setFile} current={current} />
      <div className="flex flex-wrap justify-end gap-2">
        {custom && !file && (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={remove}
          >
            스크린샷으로 되돌리기
          </Button>
        )}
        <Button type="button" disabled={busy || !file} onClick={save}>
          {busy && file ? "올리는 중…" : "저장"}
        </Button>
      </div>
    </div>
  );
}
