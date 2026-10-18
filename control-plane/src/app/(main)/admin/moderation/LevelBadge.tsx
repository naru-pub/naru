import { Badge } from "@/components/ui/badge";
import { MODERATION_LABELS, type ModerationLevel } from "@/lib/site-moderation";

export function LevelBadge({ level }: { level: ModerationLevel | null }) {
  if (!level) return <span className="text-muted-foreground">-</span>;
  return (
    <Badge variant={level === "suspended" ? "destructive" : "warning"}>
      {MODERATION_LABELS[level]}
    </Badge>
  );
}
