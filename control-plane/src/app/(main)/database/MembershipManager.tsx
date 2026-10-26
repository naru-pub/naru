"use client";
import { Checkbox } from "@/components/ui/checkbox";
import { useEffect, useState } from "react";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";

type Status = "pending" | "approved" | "banned";
type Admission = "open" | "approval" | "closed";
type Member = {
  id: string;
  status: Status;
  createdAt: string;
};
type Page = {
  admission: Admission;
  verifiedEmail: boolean;
  supportersOnly: boolean;
  members: Member[];
  nextCursor: string | null;
};
const labels = { pending: "승인 대기", approved: "승인됨", banned: "차단됨" };

export default function MembershipManager() {
  const [page, setPage] = useState<Page | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function send(url: string, body?: object): Promise<Page> {
    const response = await fetch(
      url,
      body
        ? {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        : { cache: "no-store" },
    );
    const result = await response.json();
    if (!response.ok)
      throw new Error(
        result.error?.message ?? "회원 설정을 불러오지 못했습니다.",
      );
    return result;
  }
  useEffect(() => {
    let active = true;
    send("/api/account/site-members")
      .then((value) => {
        if (active) setPage(value);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, []);
  async function change(
    body:
      | { admission: Admission }
      | { verifiedEmail: boolean }
      | { supportersOnly: boolean }
      | { id: string; status: Status },
  ) {
    setBusy(true);
    setError("");
    try {
      await send("/api/account/site-members", body);
      setPage(
        (current) =>
          current &&
          ("admission" in body ||
          "verifiedEmail" in body ||
          "supportersOnly" in body
            ? { ...current, ...body }
            : {
                ...current,
                members: current.members.map((m) =>
                  m.id === body.id ? { ...m, ...body } : m,
                ),
              }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "설정을 저장하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }
  async function more() {
    if (!page?.nextCursor) return;
    setBusy(true);
    setError("");
    try {
      const next = await send(
        `/api/account/site-members?after=${encodeURIComponent(page.nextCursor)}`,
      );
      setPage(
        (current) =>
          current && {
            ...next,
            members: [...current.members, ...next.members],
          },
      );
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "회원 목록을 불러오지 못했습니다.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="min-w-0 border p-5 space-y-4">
      <h2 className="font-bold">사이트 회원</h2>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {page && (
        <>
          <label className="flex gap-3 items-center">
            신규 가입
            <Select
              aria-label="신규 가입"
              value={page.admission}
              disabled={busy}
              onChange={(e) =>
                change({ admission: e.target.value as Admission })
              }
            >
              <option value="open">누구나 가입</option>
              <option value="approval">운영자 승인 후 이용</option>
              <option value="closed">신규 가입 중단</option>
            </Select>
          </label>
          <label className="flex cursor-pointer gap-3 items-center">
            <Checkbox
              checked={page.verifiedEmail}
              disabled={busy}
              onCheckedChange={(checked) =>
                change({ verifiedEmail: checked === true })
              }
            />
            이메일을 인증한 나루 계정만 회원으로 로그인
          </label>
          <p className="text-sm text-muted-foreground">
            켜면 이메일을 인증하지 않은 계정은 가입하거나 다시 로그인할 수
            없습니다. 이미 로그인한 회원은 로그인이 끝날 때까지 이용할 수
            있습니다. 사이트는 회원의 이메일 주소를 받지 않습니다.
          </p>
          <label className="flex cursor-pointer gap-3 items-center">
            <Checkbox
              checked={page.supportersOnly}
              disabled={busy}
              onCheckedChange={(checked) =>
                change({ supportersOnly: checked === true })
              }
            />
            나루 서포터만 회원으로 로그인
          </label>
          <p className="text-sm text-muted-foreground">
            켜면 나루 서포터 플랜이 없는 계정은 가입하거나 로그인할 수 없고,
            이미 로그인한 회원도 서포터 기간이 끝나면 바로 이용할 수 없게
            됩니다.
          </p>
          <p className="text-sm text-muted-foreground">
            승인 대기 중이거나 차단된 회원은 회원 데이터와 함수를 이용하거나
            파일을 올릴 수 없습니다. 공개 자료는 방문자로 볼 수 있습니다. 가입
            설정을 바꿔도 기존 회원의 상태는 유지됩니다.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left">
                  <th className="py-2">회원 번호</th>
                  <th>상태</th>
                  <th>변경</th>
                </tr>
              </thead>
              <tbody>
                {page.members.map((member) => (
                  <tr key={member.id} className="border-t">
                    <td className="py-3 font-mono">{member.id}</td>
                    <td>{labels[member.status]}</td>
                    <td className="py-2 flex flex-wrap gap-2">
                      {(["approved", "pending", "banned"] as const)
                        .filter((status) => status !== member.status)
                        .map((status) => (
                          <Button
                            key={status}
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            onClick={() => change({ id: member.id, status })}
                          >
                            {status === "approved"
                              ? "승인"
                              : status === "pending"
                                ? "승인 대기로"
                                : "차단"}
                          </Button>
                        ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!page.members.length && <p>아직 가입한 회원이 없습니다.</p>}
          {page.nextCursor && (
            <Button variant="outline" disabled={busy} onClick={more}>
              더 보기
            </Button>
          )}
        </>
      )}
    </section>
  );
}
