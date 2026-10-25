"use client";

/** A step of a template's work on a site, as its route streams it. */
export type TemplateProgressStep<Phase extends string> = {
  phase: Phase;
  done: number;
  total: number;
};

/**
 * Where applying, updating or removing a template has got, while it runs: the
 * phase, counted when it has more than one step, or pulsing until the first
 * step arrives.
 */
export function TemplateProgress<Phase extends string>({
  progress,
  labels,
  note,
}: {
  progress: TemplateProgressStep<Phase> | null;
  labels: Record<Phase, string>;
  note: string;
}) {
  const label = progress ? labels[progress.phase] : "시작하는 중";
  const counted = progress !== null && progress.total > 1;
  const percent =
    progress && progress.total > 0
      ? Math.round((progress.done / progress.total) * 100)
      : 0;
  return (
    <div role="status" aria-live="polite" className="space-y-2">
      <div className="flex justify-between gap-3 text-sm">
        <span className="font-bold">{label}…</span>
        {counted && (
          <span className="text-muted-foreground">
            {progress.done} / {progress.total}
          </span>
        )}
      </div>
      <div
        className="h-2 w-full overflow-hidden bg-muted"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={counted ? percent : undefined}
      >
        <div
          className={`h-full bg-primary transition-[width] ${counted ? "" : "animate-pulse"}`}
          style={{ width: counted ? `${percent}%` : "100%" }}
        />
      </div>
      <p className="text-xs text-muted-foreground">{note}</p>
    </div>
  );
}
