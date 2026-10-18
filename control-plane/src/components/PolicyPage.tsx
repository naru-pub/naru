import type { ReactNode } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// 개인정보 처리방침과 커뮤니티 가이드라인처럼 로그인 없이 읽는 정책 문서의
// 틀. 문구는 각 페이지에 두고, 이곳은 모양만 맞춘다.
export function PolicyPage({
  title,
  effectiveDate,
  children,
}: {
  title: string;
  effectiveDate: string;
  children: ReactNode;
}) {
  return (
    <div className="bg-background min-h-screen">
      <div className="max-w-3xl mx-auto p-6">
        <Card className="rounded-none bg-card border-2 border-line">
          <CardHeader className="border-b border-border">
            <CardTitle className="text-foreground text-2xl font-bold">
              <h1>{title}</h1>
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              시행일 {effectiveDate}
            </p>
          </CardHeader>
          <CardContent className="p-6 space-y-8 text-sm leading-relaxed text-muted-foreground">
            {children}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export function PolicySection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-base font-bold text-foreground">{title}</h2>
      {children}
    </section>
  );
}

export function PolicyList({ children }: { children: ReactNode }) {
  return <ul className="list-disc space-y-1.5 pl-5">{children}</ul>;
}

export function PolicyTable({
  head,
  rows,
}: {
  head: string[];
  rows: ReactNode[][];
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[36rem] border-2 border-line text-left text-xs">
        <thead className="bg-background text-foreground">
          <tr>
            {head.map((cell) => (
              <th key={cell} className="border border-border p-2 font-bold">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j} className="border border-border p-2 align-top">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Mail({ address = "hello@naru.pub" }: { address?: string }) {
  return (
    <a
      href={`mailto:${address}`}
      className="text-primary underline hover:text-primary/80"
    >
      {address}
    </a>
  );
}
