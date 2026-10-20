import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/lib/database";
import { LOGIN_NAME_REGEX } from "@/lib/const";
import { parseUuid } from "@/lib/uuid";
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
import { requireOperator } from "../_components/requireOperator";

export const metadata: Metadata = { title: "템플릿 적용 · 운영 · 나루" };

const PAGE_SIZE = 100;

export default async function TemplateApplicationsPage({
  searchParams,
}: {
  searchParams: Promise<{ user?: string; template?: string; page?: string }>;
}) {
  await requireOperator();
  const params = await searchParams;
  const userInput = params.user?.trim().toLowerCase() ?? "";
  const loginName = LOGIN_NAME_REGEX.test(userInput) ? userInput : null;
  const templateId = parseUuid(params.template);
  const page = Math.max(1, Math.min(1000, Number(params.page) || 1));

  const href = (
    changes: Partial<{
      user: string | null;
      template: string | null;
      page: number;
    }>,
  ) => {
    const next = new URLSearchParams();
    const nextUser = "user" in changes ? changes.user : loginName;
    const nextTemplate = "template" in changes ? changes.template : templateId;
    if (nextUser) next.set("user", nextUser);
    if (nextTemplate) next.set("template", nextTemplate);
    if ((changes.page ?? 1) > 1) next.set("page", String(changes.page));
    const query = next.toString();
    return query ? `/admin/templates?${query}` : "/admin/templates";
  };

  // A version is gone (version_id null) once its template post is deleted;
  // the application row stays, so those show as a deleted template.
  const rows = await db
    .selectFrom("board_template_applications as a")
    .innerJoin("users as u", "u.id", "a.user_id")
    .leftJoin("board_template_versions as v", "v.id", "a.version_id")
    .leftJoin("board_templates as t", "t.id", "v.template_id")
    .leftJoin("board_posts as p", "p.id", "t.post_id")
    .select([
      "a.id",
      "a.created_at",
      "u.login_name",
      "v.version",
      "t.id as template_id",
      "t.slug",
      "p.id as post_id",
      "p.title",
      "p.deleted_at",
    ])
    .$if(loginName !== null, (qb) => qb.where("u.login_name", "=", loginName!))
    .$if(templateId !== null, (qb) => qb.where("t.id", "=", templateId!))
    .orderBy("a.created_at", "desc")
    .orderBy("a.id", "desc")
    .limit(PAGE_SIZE + 1)
    .offset((page - 1) * PAGE_SIZE)
    .execute();
  const hasMore = rows.length > PAGE_SIZE;
  const applications = rows.slice(0, PAGE_SIZE);
  const filteredTemplate = templateId
    ? (applications[0]?.title ?? templateId)
    : null;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-xl font-bold">템플릿 적용</h2>
        <p className="text-sm text-muted-foreground">
          누가 어떤 템플릿을 자기 사이트에 적용했는지, 최근 순서.
        </p>
      </div>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2 text-xs">
          <div className="flex flex-wrap items-center gap-3 text-muted-foreground">
            {filteredTemplate && (
              <span>
                템플릿:{" "}
                <span className="font-bold text-foreground">
                  {filteredTemplate}
                </span>{" "}
                <Link
                  href={href({ template: null })}
                  className="hover:text-foreground"
                >
                  지우기
                </Link>
              </span>
            )}
          </div>
          <form action="/admin/templates" className="flex items-center gap-1">
            {templateId && (
              <input type="hidden" name="template" value={templateId} />
            )}
            <label htmlFor="applications-user" className="sr-only">
              계정
            </label>
            <Input
              id="applications-user"
              name="user"
              defaultValue={loginName ?? ""}
              placeholder="계정 아이디"
              className="h-9 w-36 md:text-xs"
            />
            <Button type="submit" variant="outline" size="sm">
              찾기
            </Button>
            {loginName && (
              <Link
                href={href({ user: null })}
                className="text-muted-foreground hover:text-foreground"
              >
                지우기
              </Link>
            )}
          </form>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>계정</TableHead>
              <TableHead>템플릿</TableHead>
              <TableHead>버전</TableHead>
              <TableHead>적용 시각</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {applications.map((application) => (
              <TableRow key={application.id}>
                <TableCell className="font-medium">
                  <Link
                    href={href({ user: application.login_name, page: 1 })}
                    className="underline"
                  >
                    {application.login_name}
                  </Link>
                </TableCell>
                <TableCell>
                  {application.template_id ? (
                    <span className="flex flex-wrap items-center gap-2">
                      <Link
                        href={href({
                          template: application.template_id,
                          page: 1,
                        })}
                        className="underline"
                      >
                        {application.title}
                      </Link>
                      <span className="text-xs text-muted-foreground">
                        {application.slug}
                      </span>
                      {application.deleted_at ? (
                        <span className="text-xs text-destructive">
                          글 삭제됨
                        </span>
                      ) : (
                        <Link
                          href={`/board/${application.post_id}`}
                          className="text-xs text-muted-foreground hover:text-foreground"
                        >
                          글 보기
                        </Link>
                      )}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">삭제된 템플릿</span>
                  )}
                </TableCell>
                <TableCell className="tabular-nums">
                  {application.version !== null
                    ? `v${application.version}`
                    : "-"}
                </TableCell>
                <TableCell className="whitespace-nowrap tabular-nums">
                  {formatDate(application.created_at)}
                </TableCell>
              </TableRow>
            ))}
            {applications.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={4}
                  className="py-10 text-center text-muted-foreground"
                >
                  템플릿을 적용한 기록이 없습니다.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>

        {(page > 1 || hasMore) && (
          <div className="flex justify-center gap-4 border-t border-border p-4 text-sm">
            {page > 1 && (
              <Link
                href={href({ page: page - 1 })}
                className="text-muted-foreground hover:text-foreground"
              >
                ← 이전
              </Link>
            )}
            <span>{page}</span>
            {hasMore && (
              <Link
                href={href({ page: page + 1 })}
                className="text-muted-foreground hover:text-foreground"
              >
                다음 →
              </Link>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
