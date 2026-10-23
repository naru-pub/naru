"use client";

import Link from "next/link";
import { useState } from "react";
import { Copy, Plug } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SCOPE_LABELS, type Scope } from "@/lib/mcp/scopes";

export interface McpConnection {
  id: string;
  name: string;
  host: string;
  scopes: Scope[];
  createdAt: string;
  lastUsedAt: string;
}

const day = (iso: string) =>
  new Date(iso).toLocaleDateString("ko-KR", { dateStyle: "medium" });

// The apps connected to the site through Naru MCP (lib/mcp/oauth.ts), each
// with 연결 끊기, which ends its tokens at once.
export default function McpConnectionsCard({
  serverUrl,
  entitled,
  connections: initial,
}: {
  serverUrl: string;
  entitled: boolean;
  connections: McpConnection[];
}) {
  const [connections, setConnections] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(serverUrl);
      toast.success("주소가 복사되었습니다.");
    } catch {
      toast.error("복사에 실패했습니다.");
    }
  }

  async function revoke(connection: McpConnection) {
    setBusy(connection.id);
    try {
      const response = await fetch(`/api/mcp/connections/${connection.id}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error((await response.json()).error?.message);
      setConnections((all) => all.filter((c) => c.id !== connection.id));
      toast.success(`${connection.name} 연결을 끊었습니다.`);
    } catch (e) {
      toast.error(
        e instanceof Error && e.message ? e.message : "연결을 끊지 못했습니다.",
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="bg-card border-2 border-line">
      <CardHeader className="border-b border-border">
        <CardTitle className="text-foreground text-xl font-bold flex items-center gap-2">
          <Plug size={20} /> MCP 연결
        </CardTitle>
      </CardHeader>
      <CardContent className="p-6 space-y-4">
        <p className="text-muted-foreground leading-relaxed">
          MCP를 지원하는 앱에서 아래 주소를 추가하면, 그 앱이 내 사이트의 파일을
          읽고 고칠 수 있습니다.{" "}
          <Link href="/docs/mcp" className="underline underline-offset-4">
            자세히
          </Link>
        </p>
        <div className="flex items-center gap-2">
          <code className="flex-1 truncate rounded border border-border bg-background px-3 py-2 text-sm">
            {serverUrl}
          </code>
          <Button variant="outline" size="sm" onClick={copyUrl}>
            <Copy className="size-4" /> 복사
          </Button>
        </div>
        {!entitled && (
          <p className="text-sm">
            MCP 연결은{" "}
            <Link href="/supporter" className="underline underline-offset-4">
              후원 플랜
            </Link>{" "}
            기능입니다.
            {connections.length > 0 &&
              " 후원이 끝난 동안에는 연결된 앱이 사이트에 닿지 못합니다."}
          </p>
        )}
        {connections.length > 0 && (
          <ul className="divide-y divide-border border-y border-border">
            {connections.map((connection) => (
              <li
                key={connection.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
              >
                <div className="min-w-0 space-y-1">
                  <p className="font-bold">
                    {connection.name}{" "}
                    <span className="font-normal text-muted-foreground">
                      · {connection.host}
                    </span>
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {connection.scopes
                      .map((scope) => SCOPE_LABELS[scope])
                      .join(", ")}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {day(connection.createdAt)} 연결 · 마지막 사용{" "}
                    {day(connection.lastUsedAt)}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy === connection.id}
                  onClick={() => revoke(connection)}
                >
                  연결 끊기
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
