import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/lib/database";
import { SELLER_INTEREST_PRICES } from "@/lib/board/seller-interest-options";
import { Card } from "@/components/ui/card";
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

export const metadata: Metadata = { title: "판매 관심 · 운영 · 나루" };

export default async function SellerInterestPage() {
  await requireOperator();
  const answers = await db
    .selectFrom("template_seller_interest as i")
    .innerJoin("users as u", "u.id", "i.user_id")
    .select([
      "i.id",
      "i.description",
      "i.price_range",
      "i.updated_at",
      "u.login_name",
      "u.email",
    ])
    .orderBy("i.updated_at", "desc")
    .execute();

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-xl font-bold">판매 관심</h2>
        <p className="text-sm text-muted-foreground">
          템플릿을 판매하고 싶다고 알려 준 {answers.length}명, 최근 순서.
        </p>
      </div>
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>계정</TableHead>
              <TableHead>이메일</TableHead>
              <TableHead>가격</TableHead>
              <TableHead>어떤 템플릿</TableHead>
              <TableHead>보낸 때</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {answers.map((answer) => (
              <TableRow key={answer.id}>
                <TableCell>
                  <Link
                    href={`/admin/users/${answer.login_name}`}
                    className="text-primary hover:underline"
                  >
                    {answer.login_name}
                  </Link>
                </TableCell>
                <TableCell>{answer.email}</TableCell>
                <TableCell className="whitespace-nowrap">
                  {SELLER_INTEREST_PRICES[answer.price_range]}
                </TableCell>
                <TableCell className="min-w-64 whitespace-pre-wrap break-words">
                  {answer.description}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {formatDate(answer.updated_at)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
