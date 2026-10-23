"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { basename, fuzzyFilter, parentOf } from "./file-tree";
import { getFileIcon } from "./file-icons";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  paths: string[];
  // Open tabs, most recent first: what an empty query lists.
  recent: string[];
  onPick: (path: string) => void;
}

/** Go to a file by typing part of its path (Cmd/Ctrl+P). */
export default function QuickOpen(props: Props) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        hideClose
        className="top-[15%] max-w-xl translate-y-0 gap-2 p-2"
      >
        <DialogTitle className="sr-only">파일로 이동</DialogTitle>
        <DialogDescription className="sr-only">
          파일 이름을 입력하고 Enter로 엽니다.
        </DialogDescription>
        {/* Unmounted while closed, so each opening starts empty. */}
        <QuickOpenList {...props} />
      </DialogContent>
    </Dialog>
  );
}

function QuickOpenList({ onOpenChange, paths, recent, onPick }: Props) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const matches = useMemo(() => {
    if (query.trim()) return fuzzyFilter(query, paths);
    const rest = paths.filter((path) => !recent.includes(path));
    return [...recent.filter((path) => paths.includes(path)), ...rest].slice(
      0,
      50,
    );
  }, [query, paths, recent]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${index}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const pick = (path: string | undefined) => {
    if (!path) return;
    onOpenChange(false);
    onPick(path);
  };

  return (
    <>
      <Input
        autoFocus
        value={query}
        placeholder="파일 이름으로 이동..."
        onChange={(e) => {
          setQuery(e.target.value);
          setIndex(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setIndex((i) => Math.min(i + 1, matches.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setIndex((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            pick(matches[index]);
          }
        }}
      />
      <ul
        ref={listRef}
        role="listbox"
        aria-label="파일"
        className="max-h-80 overflow-y-auto"
      >
        {matches.map((path, i) => (
          <li
            key={path}
            role="option"
            aria-selected={i === index}
            data-index={i}
            className={`flex cursor-pointer items-center gap-2 px-2 py-1.5 text-sm ${
              i === index ? "bg-primary/10 text-primary" : "hover:bg-accent"
            }`}
            onMouseMove={() => setIndex(i)}
            onClick={() => pick(path)}
          >
            {getFileIcon(path, false)}
            <span className="truncate font-medium">{basename(path)}</span>
            <span className="truncate text-xs text-muted-foreground">
              {parentOf(path)}
            </span>
          </li>
        ))}
        {matches.length === 0 && (
          <li className="px-2 py-4 text-center text-sm text-muted-foreground">
            일치하는 파일이 없습니다
          </li>
        )}
      </ul>
    </>
  );
}
