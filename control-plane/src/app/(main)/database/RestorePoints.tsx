"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/confirm";
import {
  MANUAL_RESTORE_POINTS_PER_HOUR,
  RESTORE_POINT_DAYS,
  RESTORE_POINT_KEEP_MS,
} from "@/lib/site-functions/restore-points";

type RestorePoint = {
  name: string;
  createdAt: number;
  kind: "release" | "before-restore" | "manual";
  generation: string | null;
  size: number;
};

const when = (ms: number) =>
  new Date(ms).toLocaleString("ko-KR", {
    dateStyle: "medium",
    timeStyle: "medium",
  });
const day = (ms: number) =>
  new Date(ms).toLocaleDateString("ko-KR", { dateStyle: "medium" });
const size = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024)).toLocaleString("ko-KR")} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function send<T>(
  body?: { name: string } | { create: true } | { reset: string },
): Promise<T> {
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
 * migrations run, one before each restore, so a restore can be undone, and
 * one whenever the owner asks. Each downloads as its gzip NDJSON. The site's
 * database can be emptied here too, after one is kept.
 */
export default function RestorePoints({
  site,
  onReset,
}: {
  site: string;
  onReset?: () => void;
}) {
  const confirm = useConfirm();
  const [points, setPoints] = useState<RestorePoint[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [typed, setTyped] = useState("");

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

  async function create() {
    setBusy(true);
    setError("");
    setDone("");
    try {
      const { saved } = await send<{ saved: RestorePoint }>({ create: true });
      setDone(`${when(saved.createdAt)} 복원 지점을 만들었습니다.`);
      await load();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "복원 지점을 만들지 못했습니다.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function restore(point: RestorePoint) {
    if (
      !(await confirm({
        title: `${when(point.createdAt)}로 복원할까요?`,
        description:
          "사이트의 컬렉션과 문서, SQL 테이블과 그 행, 적용된 마이그레이션이 이 시점으로 돌아갑니다. 그 뒤에 생기거나 바뀐 데이터는 모두 이 시점의 것으로 바뀝니다. 복원하기 전에 지금 상태를 새 복원 지점으로 남기므로, 그 지점으로 다시 복원하면 되돌릴 수 있습니다. 사이트 코드는 지금 릴리스 그대로이며, 이 시점에 적용되지 않았던 마이그레이션은 다음에 _naru 파일을 올릴 때 다시 적용됩니다.",
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

  async function reset() {
    if (
      !(await confirm({
        title: "데이터베이스를 초기화할까요?",
        description:
          "컬렉션과 문서, SQL 테이블과 그 행, 적용된 마이그레이션 기록을 모두 지우고, 사이트 코드를 다시 릴리스해 마이그레이션을 처음부터 적용합니다. 지우기 전에 지금 상태를 복원 지점으로 남기므로, 그 지점으로 복원하면 되돌릴 수 있습니다. 사이트 파일과 미디어, 사이트 회원 목록은 그대로입니다.",
        confirmText: "초기화",
        destructive: true,
      }))
    )
      return;
    setBusy(true);
    setError("");
    setDone("");
    try {
      const result = await send<{
        saved: RestorePoint;
        revision: string | null;
        releaseError: string | null;
      }>({ reset: typed });
      setTyped("");
      setDone(
        `데이터베이스를 초기화했습니다. 초기화 전 상태는 ${when(result.saved.createdAt)} 복원 지점으로 남겼습니다.${
          result.releaseError
            ? ` 사이트 코드는 릴리스하지 못했습니다: ${result.releaseError}`
            : ""
        }`,
      );
      await load();
      onReset?.();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "데이터베이스를 초기화하지 못했습니다.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="min-w-0 border p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-bold">복원 지점</h2>
          <Button size="sm" disabled={busy} onClick={() => void create()}>
            지금 복원 지점 만들기
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          릴리스가 새 마이그레이션(<code>_naru/migrations/</code>)을 적용하기
          직전, 그리고 복원하기 직전에 사이트 데이터 전체를 복원 지점으로
          남깁니다. 지금 상태를 직접 남길 수도 있습니다(한 시간에{" "}
          {MANUAL_RESTORE_POINTS_PER_HOUR}개까지). 복원하면 컬렉션과 문서, SQL
          테이블, 적용된 마이그레이션 기록이 그 시점으로 돌아갑니다. 사이트
          코드, 요금제와 이용 한도는 그대로입니다.
        </p>
        <p className="text-sm text-muted-foreground">
          직접 만든 것을 포함해 복원 지점은 만든 때부터 {RESTORE_POINT_DAYS}일
          동안 보관하고, 그 뒤에 삭제합니다. 더 오래 두려면 내려받아 보관하세요.
          내려받은 파일은 gzip으로 압축한 NDJSON으로, 사이트 데이터 전체가 한
          줄에 한 행씩 들어 있습니다.
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
                  <th>보관</th>
                  <th>
                    <span className="sr-only">내려받기와 복원</span>
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
                      ) : point.kind === "manual" ? (
                        "직접 만듦"
                      ) : (
                        "복원 직전"
                      )}
                    </td>
                    <td>{size(point.size)}</td>
                    <td>
                      {day(point.createdAt + RESTORE_POINT_KEEP_MS)} 삭제 예정
                    </td>
                    <td className="space-x-2 whitespace-nowrap py-2 text-right">
                      <Button variant="ghost" size="sm" asChild>
                        <a
                          href={`/api/account/restore-points?download=${encodeURIComponent(point.name)}`}
                          download
                        >
                          내려받기
                        </a>
                      </Button>
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
      <section className="min-w-0 border border-destructive/40 p-5 space-y-3">
        <h2 className="font-bold">데이터베이스 초기화</h2>
        <p className="text-sm text-muted-foreground">
          사이트 데이터를 모두 지우고 처음부터 시작합니다. 첫 공개 전에
          마이그레이션을 하나로 합치는 것처럼, 적용된 마이그레이션을 바꿔야 할
          때 씁니다. 지우기 전에 지금 상태를 복원 지점으로 남기고, 지운 뒤에는
          사이트 코드를 다시 릴리스해 <code>_naru/migrations/</code>를 빈
          데이터베이스에 적용합니다. 바꾼 마이그레이션을 먼저 올리세요(릴리스는
          거절되지만 파일은 남고, 초기화가 그 파일을 릴리스합니다). 사이트
          파일과 미디어, 사이트 회원 목록은 그대로입니다.
        </p>
        <label className="block space-y-1 text-sm" htmlFor="reset-site-name">
          <span>
            확인을 위해 사이트 이름 <code>{site}</code>을 입력하세요
          </span>
          <Input
            id="reset-site-name"
            value={typed}
            autoComplete="off"
            onChange={(event) => setTyped(event.target.value)}
          />
        </label>
        <Button
          variant="destructive"
          size="sm"
          disabled={busy || typed !== site}
          onClick={() => void reset()}
        >
          데이터베이스 초기화
        </Button>
      </section>
    </div>
  );
}
