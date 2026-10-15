"use client";
import { useState } from "react";
import type {
  AuthorizationInput,
  AuthorizationSetup,
} from "@/lib/site-data/owner-auth";
import { Button } from "@/components/ui/button";
import CollectionChanges from "../CollectionChanges";

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
      <CollectionChanges setup={{ create: setup.create, configure: [] }} />
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
