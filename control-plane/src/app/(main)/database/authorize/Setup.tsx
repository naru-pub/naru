"use client";
import { useState } from "react";
import type {
  AuthorizationInput,
  AuthorizationSetup,
} from "@/lib/site-data/owner-auth";
import { Button } from "@/components/ui/button";

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
  return (
    <div className="max-w-xl mx-auto p-6 space-y-5">
      <h1 className="text-2xl font-bold">관리자 로그인 준비</h1>
      <p>
        사이트 <strong>{input.site}</strong>의 아래 페이지가 관리자 로그인을
        요청했습니다. 먼저 이 페이지가 필요로 하는 것을 준비합니다.
      </p>
      <p className="break-all rounded bg-muted p-3">{input.redirectUri}</p>
      <ul className="list-disc space-y-2 pl-6">
        {setup.create.length > 0 && (
          <li>
            컬렉션 <strong>{setup.create.join(", ")}</strong>을(를) 새로
            만듭니다.
            <ul className="mt-1 list-[circle] pl-5">
              {setup.create.map((collection) => {
                const wanted = input.settings?.[collection];
                return (
                  <li key={collection}>
                    {collection}: 읽기 {ACCESS[wanted?.read ?? "admin"]}, 쓰기{" "}
                    {ACCESS[wanted?.write ?? "admin"]}
                    {wanted?.rules ? `, 규칙 ${wanted.rules}` : ""}
                    {wanted?.unique?.length
                      ? `, 중복 금지 ${wanted.unique.join(", ")}`
                      : ""}
                  </li>
                );
              })}
            </ul>
            설정은 나중에 제어판에서 바꿀 수 있습니다.
          </li>
        )}
        {setup.configure.length > 0 && (
          <li>
            이 페이지가 요청한 대로 기존 컬렉션의 설정을 바꿉니다.
            <ul className="mt-1 list-[circle] pl-5">
              {setup.configure.map(({ name, changes }) => (
                <li key={name}>
                  {name}:{" "}
                  {Object.entries(changes).map(([key, change], index) => (
                    <span
                      key={key}
                      className={
                        widens(key, change)
                          ? "font-semibold text-destructive"
                          : ""
                      }
                    >
                      {index ? ", " : ""}
                      {LABELS[key]} {shown(key, change[0])} →{" "}
                      {shown(key, change[1])}
                    </span>
                  ))}
                </li>
              ))}
            </ul>
            {setup.configure.some(({ changes }) =>
              Object.entries(changes).some(([key, change]) =>
                widens(key, change),
              ),
            ) && (
              <p className="mt-1 text-sm text-destructive">
                빨간 항목은 관리자만 보던 자료를 회원이나 방문자에게 엽니다.
                규칙이 함께 설정되는지 확인하세요.
              </p>
            )}
          </li>
        )}
        {setup.register ? (
          <li>
            이 페이지를 ‘웹사이트 관리자 로그인’에 등록하고{" "}
            <strong>{input.collections.join(", ")}</strong> 컬렉션을 허용합니다.
          </li>
        ) : setup.create.length + setup.extend.length === 0 ? null : (
          <li>
            이 페이지의 등록에{" "}
            <strong>{[...setup.extend, ...setup.create].join(", ")}</strong>{" "}
            컬렉션을 추가합니다. 이 페이지에 이미 로그인된 곳은 모두
            로그아웃됩니다.
          </li>
        )}
      </ul>
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
