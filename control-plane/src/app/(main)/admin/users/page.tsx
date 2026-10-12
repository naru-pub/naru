import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/database";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate } from "../_components/format";
import { supporterCondition } from "../_components/metrics";
import { requireOperator } from "../_components/requireOperator";

export const metadata: Metadata = { title: "계정 · 운영 · 나루" };

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ user?: string }>;
}) {
  await requireOperator();
  const query = (await searchParams).user?.trim().toLowerCase() || null;
  const now = new Date();

  if (query) {
    const found = await db
      .selectFrom("users")
      .select("login_name")
      .where("login_name", "=", query)
      .executeTakeFirst();
    if (found) redirect(`/admin/users/${encodeURIComponent(found.login_name)}`);
  }

  const recent = await db
    .selectFrom("users")
    .select([
      "id",
      "login_name",
      "created_at",
      "deleted_at",
      "supporter_comp",
      supporterCondition(now).as("supporter"),
    ])
    .orderBy("created_at", "desc")
    .limit(50)
    .execute();

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-xl font-bold">계정</h2>
        <p className="text-sm text-muted-foreground">
          아이디로 계정을 찾으면 그 계정의 사용량, 결제, 템플릿 적용을 한눈에
          봅니다.
        </p>
      </div>

      <form action="/admin/users" className="flex items-center gap-2">
        <label htmlFor="users-search" className="sr-only">
          계정 아이디
        </label>
        <Input
          id="users-search"
          name="user"
          defaultValue={query ?? ""}
          placeholder="계정 아이디"
          className="w-48"
        />
        <Button type="submit" variant="outline">
          찾기
        </Button>
        {query && (
          <span className="text-sm text-destructive">
            {query} 계정이 없습니다.
          </span>
        )}
      </form>

      <div className="space-y-2">
        <h3 className="font-bold">최근 가입한 계정</h3>
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>계정</TableHead>
                <TableHead>이용</TableHead>
                <TableHead>가입</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recent.map((user) => (
                <TableRow key={user.id}>
                  <TableCell className="font-medium">
                    <Link
                      href={`/admin/users/${encodeURIComponent(user.login_name)}`}
                      className="underline"
                    >
                      {user.login_name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {user.deleted_at ? (
                      <Badge variant="destructive">삭제됨</Badge>
                    ) : user.supporter_comp ? (
                      <Badge variant="secondary">무료 제공</Badge>
                    ) : user.supporter ? (
                      <Badge variant="outline">유료</Badge>
                    ) : (
                      <span className="text-muted-foreground">무료</span>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">
                    {formatDate(user.created_at)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>
    </div>
  );
}
