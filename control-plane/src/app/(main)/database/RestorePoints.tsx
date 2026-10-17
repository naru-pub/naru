"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";

type RestorePoint = {
  name: string;
  createdAt: number;
  kind: "release" | "before-restore";
  generation: string | null;
  size: number;
};

const when = (ms: number) =>
  new Date(ms).toLocaleString("ko-KR", {
    dateStyle: "medium",
    timeStyle: "medium",
  });
const size = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024)).toLocaleString("ko-KR")} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function send<T>(body?: { name: string }): Promise<T> {
  const response = await fetch(
    "/api/account/restore-points",
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : { cache: "no-store" },
  );
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      result.error?.message ?? "복원 지점을 불러오지 못했습니다.",
    );
  return result;
}

/**
 * The site's restore points (1.1.0): one is kept before each release's
 * migrations run, and one before each restore, so a restore can be undone.
 */
export default function RestorePoints() {
  const confirm = useConfirm();
  const [points, setPoints] = useState<RestorePoint[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  async function load() {
    const { restorePoints } = await send<{ restorePoints: RestorePoint[] }>();
    setPoints(restorePoints);
  }
  useEffect(() => {
    let active = true;
    send<{ restorePoints: RestorePoint[] }>()
      .then(({ restorePoints }) => {
        if (active) setPoints(restorePoints);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, []);

  async function restore(point: RestorePoint) {
    if (
      !(await confirm({
        title: `${when(point.createdAt)}로 복원할까요?`,
        description:
          "사이트의 컬렉션과 문서, SQL 테이블과 그 행, 적용된 마이그레이션, 회원 역할이 이 시점으로 돌아갑니다. 그 뒤에 생기거나 바뀐 데이터는 모두 이 시점의 것으로 바뀝니다. 복원하기 전에 지금 상태를 새 복원 지점으로 남기므로, 그 지점으로 다시 복원하면 되돌릴 수 있습니다. 사이트 코드는 지금 릴리스 그대로이며, 이 시점에 적용되지 않았던 마이그레이션은 다음에 _naru 파일을 올릴 때 다시 적용됩니다.",
        confirmText: "복원",
        destructive: true,
      }))
    )
      return;
    setBusy(true);
    setError("");
    setDone("");
    try {
      const restored = await send<{ saved: RestorePoint | null }>({
        name: point.name,
      });
      setDone(
        `${when(point.createdAt)}로 복원했습니다.${
          restored.saved
            ? ` 복원 전 상태는 ${when(restored.saved.createdAt)} 복원 지점으로 남겼습니다.`
            : ""
        }`,
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "복원하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="min-w-0 border p-5 space-y-4">
      <h2 className="font-bold">복원 지점</h2>
      <p className="text-sm text-muted-foreground">
        릴리스가 새 마이그레이션(<code>_naru/migrations/</code>)을 적용하기
        직전, 그리고 복원하기 직전에 사이트 데이터 전체를 복원 지점으로
        남깁니다. 복원하면 컬렉션과 문서, SQL 테이블, 적용된 마이그레이션 기록,
        회원 역할이 그 시점으로 돌아갑니다. 사이트 코드, 요금제와 이용 한도는
        그대로입니다.
      </p>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {done && <p role="status">{done}</p>}
      {points && !points.length && <p>아직 복원 지점이 없습니다.</p>}
      {points && points.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left">
                <th className="py-2">만든 때</th>
                <th>남긴 까닭</th>
                <th>크기</th>
                <th>
                  <span className="sr-only">복원</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {points.map((point) => (
                <tr key={point.name} className="border-t">
                  <td className="py-3">{when(point.createdAt)}</td>
                  <td>
                    {point.kind === "release" ? (
                      <>
                        릴리스 직전{" "}
                        <span className="font-mono text-xs text-muted-foreground">
                          {point.generation}
                        </span>
                      </>
                    ) : (
                      "복원 직전"
                    )}
                  </td>
                  <td>{size(point.size)}</td>
                  <td className="py-2 text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => void restore(point)}
                    >
                      복원
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
