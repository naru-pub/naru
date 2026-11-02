"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { boardRequest } from "../../_components/api";
import { TagInput } from "../../_components/TagInput";

export function TagsForm({
  templateId,
  tags: initial,
  suggestions,
}: {
  templateId: string;
  tags: string[];
  suggestions: string[];
}) {
  const router = useRouter();
  const [tags, setTags] = useState(initial);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await boardRequest(`/api/board/templates/${templateId}/tags`, "PUT", {
        tags,
      });
      toast.success("태그를 저장했어요.");
      router.refresh();
    } catch (error: any) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <TagInput
        id="template-tags"
        value={tags}
        onChange={setTags}
        suggestions={suggestions}
      />
      <Button type="button" onClick={save} disabled={busy}>
        태그 저장
      </Button>
    </div>
  );
}
