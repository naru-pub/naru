"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MAX_POST_BODY_LENGTH, MAX_TITLE_LENGTH } from "@/lib/board/constants";
import { boardRequest } from "../_components/api";

export function NewPostForm() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const { postId } = await boardRequest<{ postId: string }>(
        "/api/board/posts",
        "POST",
        { kind: "site", title, body },
      );
      router.push(`/board/${postId}`);
      router.refresh();
    } catch (error: any) {
      toast.error(error.message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-6">
      <div className="space-y-2">
        <label htmlFor="post-title" className="text-sm font-bold">
          제목
        </label>
        <Input
          id="post-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={MAX_TITLE_LENGTH}
          required
          className="h-12 md:text-base"
        />
        <p className="text-xs text-muted-foreground">
          내 사이트의 최신 스크린샷이 글에 붙어요.
        </p>
      </div>

      <div className="space-y-2">
        <label htmlFor="post-body" className="text-sm font-bold">
          본문
        </label>
        <Textarea
          id="post-body"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          maxLength={MAX_POST_BODY_LENGTH}
          rows={8}
        />
        <p className="text-xs text-muted-foreground">
          빈 줄로 문단을 나눠요. 웹 주소는 링크가 돼요.
        </p>
      </div>

      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="lg"
          onClick={() => router.back()}
          className="text-sm"
        >
          취소
        </Button>
        <Button type="submit" size="lg" disabled={busy} className="text-sm">
          {busy ? "올리는 중…" : "게시하기"}
        </Button>
      </div>
    </form>
  );
}
