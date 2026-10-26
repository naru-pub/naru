"use client";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import SwitchAccount from "@/components/SwitchAccount";
import { SCOPE_LABELS, type Scope } from "@/lib/mcp/scopes";
import { PANEL } from "./panel";

export default function McpConsent({
  request,
  appName,
  host,
  identity,
  loopback,
  scopes,
  account,
  entitled,
}: {
  request: Record<string, string>;
  appName: string;
  host: string;
  /** The host whose metadata document names the app, when it has one. */
  identity: string | null;
  /** Whether the app returns to a program on this computer. */
  loopback: boolean;
  scopes: Scope[];
  account: string;
  entitled: boolean;
}) {
  const [kept, setKept] = useState<Scope[]>(scopes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function answer(approve: boolean) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/mcp/oauth/authorize", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request, approve, scope: kept.join(" ") }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message);
      window.location.assign(result.redirect);
    } catch (e) {
      setError(
        e instanceof Error && e.message ? e.message : "연결하지 못했습니다.",
      );
      setBusy(false);
    }
  }

  return (
    <div className={PANEL}>
      <h1 className="text-2xl font-bold">MCP 연결</h1>
      <p>
        <strong>{appName}</strong>이(가) <strong>{account}</strong>의 사이트에
        연결하려고 합니다.
      </p>
      <p className="text-sm text-muted-foreground">
        {identity ? (
          <>
            앱 정보는 <code>{identity}</code>에서 확인했습니다.{" "}
          </>
        ) : (
          <>앱 이름은 앱이 직접 밝힌 것입니다. </>
        )}
        연결이 끝나면 <code>{host}</code>(으)로 돌아갑니다. 쓰려던 앱의 주소인지
        확인하세요.
      </p>
      {loopback && (
        <p role="note" className="text-sm">
          이 앱은 이 컴퓨터에서 실행되는 프로그램으로 돌아갑니다. 직접 시작한
          연결이 아니라면 취소하세요.
        </p>
      )}
      {entitled ? (
        <>
          <fieldset className="space-y-3">
            <legend className="mb-2 font-bold">허용할 일</legend>
            {scopes.map((scope) => (
              <div key={scope} className="flex items-center gap-2">
                <Checkbox
                  id={`scope-${scope}`}
                  checked={kept.includes(scope)}
                  disabled={busy}
                  onCheckedChange={(checked) =>
                    setKept(
                      scopes.filter((s) =>
                        s === scope ? checked === true : kept.includes(s),
                      ),
                    )
                  }
                />
                <Label htmlFor={`scope-${scope}`}>{SCOPE_LABELS[scope]}</Label>
              </div>
            ))}
          </fieldset>
          <p className="text-sm text-muted-foreground">
            앱은 사이트 파일만 다루며, 계정 설정과 결제에는 닿지 않습니다.{" "}
            <Link href="/account" className="underline">
              계정
            </Link>
            에서 언제든 연결을 끊을 수 있습니다.
          </p>
        </>
      ) : (
        <p>
          MCP 연결은{" "}
          <Link href="/supporter" className="underline">
            서포터 플랜
          </Link>{" "}
          기능입니다.
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-3">
        {entitled && (
          <Button
            disabled={busy || kept.length === 0}
            onClick={() => answer(true)}
          >
            연결
          </Button>
        )}
        <Button disabled={busy} variant="outline" onClick={() => answer(false)}>
          취소
        </Button>
      </div>
      <SwitchAccount account={account} />
    </div>
  );
}
