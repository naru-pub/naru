"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  MAX_TAG_LENGTH,
  MAX_TEMPLATE_TAGS,
  isValidTag,
  normalizeTag,
} from "@/lib/board/tags";

// Tags are the author's own words. The ones other templates already use are
// offered first, so the same idea tends to end up under one tag.
export function TagInput({
  id,
  value,
  onChange,
  suggestions,
}: {
  id: string;
  value: string[];
  onChange: (tags: string[]) => void;
  suggestions: string[];
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const full = value.length >= MAX_TEMPLATE_TAGS;

  // A comma can arrive in the text itself: pasted, or typed to end a Korean
  // composition, when the key press doesn't reach onKeyDown.
  function add(raw: string) {
    const tags = raw.split(",").map(normalizeTag).filter(Boolean);
    if (!tags.every(isValidTag)) {
      setError(`태그는 ${MAX_TAG_LENGTH}자 안의 글자와 숫자로 적어 주세요.`);
      return;
    }
    setError(null);
    setDraft("");
    if (tags.length > 0) {
      onChange([...new Set([...value, ...tags])].slice(0, MAX_TEMPLATE_TAGS));
    }
  }

  const offered = suggestions.filter((tag) => !value.includes(tag));

  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {value.map((tag) => (
            <li
              key={tag}
              className="inline-flex items-center gap-1 bg-accent pl-2 text-sm text-accent-foreground"
            >
              {tag}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => onChange(value.filter((t) => t !== tag))}
                aria-label={`태그 ${tag} 지우기`}
                className="size-8"
              >
                <X size={14} aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Input
        id={id}
        value={draft}
        disabled={full}
        placeholder={
          full
            ? `태그는 ${MAX_TEMPLATE_TAGS}개까지 달 수 있어요`
            : "태그를 적고 Enter (블로그, 커뮤…)"
        }
        onChange={(event) => {
          setDraft(event.target.value);
          if (event.target.value.includes(",")) add(event.target.value);
        }}
        onBlur={() => add(draft)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            if (!event.nativeEvent.isComposing) add(draft);
          }
        }}
      />
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {!full && offered.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          많이 쓰는 태그
          {offered.map((tag) => (
            <Button
              key={tag}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => add(tag)}
            >
              {tag}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
