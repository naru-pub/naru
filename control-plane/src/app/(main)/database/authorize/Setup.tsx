"use client";
import { useState } from "react";
import type {
  AuthorizationInput,
  AuthorizationSetup,
} from "@/lib/site-data/owner-auth";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const ACCESS: Record<string, string> = {
  admin: "관리자만",
  member: "회원",
  create: "누구나 새 글만",
  world: "누구나",
};
const LABELS: Record<string, string> = {
  read: "읽기",
  write: "쓰기",
  rules: "규칙",
  unique: "중복 금지 필드",
};
const shown = (key: string, value: string) =>
  key === "read" || key === "write"
    ? (ACCESS[value] ?? value)
    : value || "없음";
// Opening a collection beyond admins is called out before the owner agrees.
const widens = (key: string, [from, to]: [string, string]) =>
  (key === "read" || key === "write") && from === "admin" && to !== "admin";

// Shown instead of an error when the page asking for sign-in is not set up
// yet. Nothing changes until the owner clicks; approving access is still the
// separate consent step that follows.
export default function Setup({
  input,
  setup,
}: {
  input: AuthorizationInput;
  setup: AuthorizationSetup;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function prepare() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/data-auth/prepare", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      // The same request again, which now reaches the consent step.
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "설정하지 못했습니다.");
      setBusy(false);
    }
  }
  function deny() {
    const url = new URL(input.redirectUri);
    url.searchParams.set("error", "access_denied");
    url.searchParams.set("state", input.state);
    window.location.assign(url.href);
  }
  const widened = setup.configure.some(({ changes }) =>
    Object.entries(changes).some(([key, change]) => widens(key, change)),
  );
  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-bold">관리자 로그인 준비</h1>
        <p>
          사이트 <strong>{input.site}</strong>의 아래 페이지가 관리자 로그인을
          요청했습니다. 먼저 이 페이지가 필요로 하는 것을 준비합니다.
        </p>
        <p className="break-all rounded bg-muted p-3 font-mono text-sm">
          {input.redirectUri}
        </p>
      </div>
      {setup.create.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-bold">
            새로 만들 컬렉션 ({setup.create.length})
          </h2>
          <div className="overflow-x-auto border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>컬렉션</TableHead>
                  <TableHead>읽기</TableHead>
                  <TableHead>쓰기</TableHead>
                  <TableHead>규칙</TableHead>
                  <TableHead>중복 금지 필드</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {setup.create.map((collection) => {
                  const wanted = input.settings?.[collection];
                  return (
                    <TableRow key={collection}>
                      <TableCell className="font-mono">{collection}</TableCell>
                      <TableCell>{ACCESS[wanted?.read ?? "admin"]}</TableCell>
                      <TableCell>{ACCESS[wanted?.write ?? "admin"]}</TableCell>
                      <TableCell className="font-mono">
                        {wanted?.rules || "—"}
                      </TableCell>
                      <TableCell className="font-mono">
                        {wanted?.unique?.join(", ") || "—"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <p className="text-sm text-muted-foreground">
            설정은 나중에 제어판에서 바꿀 수 있습니다.
          </p>
        </section>
      )}
      {setup.configure.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-bold">
            설정이 바뀌는 컬렉션 ({setup.configure.length})
          </h2>
          <div className="overflow-x-auto border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>컬렉션</TableHead>
                  <TableHead>항목</TableHead>
                  <TableHead>지금</TableHead>
                  <TableHead>바뀐 뒤</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {setup.configure.flatMap(({ name, changes }) =>
                  Object.entries(changes).map(([key, change], index) => (
                    <TableRow
                      key={`${name}:${key}`}
                      className={
                        widens(key, change)
                          ? "font-semibold text-destructive"
                          : undefined
                      }
                    >
                      <TableCell className="font-mono">
                        {index === 0 ? name : ""}
                      </TableCell>
                      <TableCell>{LABELS[key]}</TableCell>
                      <TableCell>{shown(key, change[0])}</TableCell>
                      <TableCell>{shown(key, change[1])}</TableCell>
                    </TableRow>
                  )),
                )}
              </TableBody>
            </Table>
          </div>
          {widened && (
            <p className="text-sm text-destructive">
              빨간 줄은 관리자만 보던 자료를 회원이나 방문자에게 엽니다. 규칙이
              함께 설정되는지 확인하세요.
            </p>
          )}
        </section>
      )}
      <section className="space-y-1 text-sm">
        <h2 className="font-bold text-base">이 페이지의 등록</h2>
        {setup.register ? (
          <p>
            ‘웹사이트 관리자 로그인’에 이 페이지를 등록하고 요청한 컬렉션{" "}
            {input.collections.length}개를 허용합니다.
          </p>
        ) : setup.create.length + setup.extend.length === 0 ? (
          <p>등록은 바뀌지 않으며, 로그인된 곳도 그대로입니다.</p>
        ) : (
          <p>
            등록에 컬렉션 {setup.extend.length + setup.create.length}개를
            추가합니다. 이 페이지에 이미 로그인된 곳은 모두 로그아웃됩니다.
          </p>
        )}
      </section>
      <p className="text-sm text-muted-foreground">
        내가 만든 페이지가 맞는지 주소를 확인하세요. 준비한 뒤에도 접근 허용은
        다음 화면에서 따로 승인합니다.
      </p>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-3">
        <Button disabled={busy} onClick={prepare}>
          준비하고 계속
        </Button>
        <Button disabled={busy} variant="outline" onClick={deny}>
          취소
        </Button>
      </div>
    </div>
  );
}
