import type { Metadata } from "next";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  RULE_ACTION_LABELS,
  cloudflareZone,
  listCustomRules,
  type FirewallRule,
} from "@/lib/cloudflare/firewall";
import {
  SITE_LIMIT_RULE_REF,
  monthlyAllowance,
  siteRequestStatuses,
} from "@/lib/edge/site-requests";
import { requireOperator } from "../_components/requireOperator";
import {
  RuleButtons,
  RuleForm,
  SiteOverrideButtons,
  SiteOverrideForm,
} from "./FirewallControls";

export const metadata: Metadata = { title: "방화벽 · 운영 · 나루" };

const count = (value: number) => new Intl.NumberFormat("ko-KR").format(value);

export default async function FirewallPage() {
  await requireOperator();
  const allowance = monthlyAllowance();
  const sites = await siteRequestStatuses();
  let rules: FirewallRule[] = [];
  let rulesError: string | null = null;
  if (!cloudflareZone()) rulesError = "Cloudflare 설정이 없어요.";
  else
    try {
      rules = await listCustomRules();
    } catch (error) {
      rulesError = error instanceof Error ? error.message : String(error);
    }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-xl font-bold">방화벽</h2>
        <p className="text-sm text-muted-foreground">
          naru.pub 영역의 WAF 사용자 규칙이에요. Cloudflare가 엣지 워커보다 먼저
          적용해서, 막힌 요청은 워커 요청으로 과금되지 않아요. 바꾼 내용은 운영
          Discord 채널에 알려요.
        </p>
      </div>

      <Card className="space-y-4 p-4">
        <div className="space-y-1">
          <h3 className="font-bold">사이트 요청 한도</h3>
          <p className="text-sm text-muted-foreground">
            사이트마다 한 달(UTC)에 {count(allowance)}회까지 요청을 받아요. 넘은
            사이트는 그 달이 끝날 때까지 차단해요. 후원자 사이트와 예외로 둔
            사이트는 차단하지 않아요. 요청 수는 매시간 Cloudflare 분석에서
            세어요. 한도의 절반을 넘은 사이트와 지정한 사이트만 보여요.
          </p>
        </div>
        <SiteOverrideForm />
        {sites.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            이번 달 한도의 절반을 넘은 사이트가 없어요.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>사이트</TableHead>
                <TableHead className="text-right">이번 달 요청</TableHead>
                <TableHead>상태</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sites.map((site) => (
                <TableRow key={site.userId}>
                  <TableCell className="font-medium">{site.login}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {count(site.requests)}{" "}
                    <span className="text-muted-foreground">
                      ({Math.round((site.requests / allowance) * 100)}%)
                    </span>
                  </TableCell>
                  <TableCell className="space-x-1">
                    {site.blocked ? (
                      <Badge variant="destructive">차단됨</Badge>
                    ) : (
                      <Badge variant="outline">허용</Badge>
                    )}
                    {site.override === "block" && (
                      <Badge variant="outline">항상 차단</Badge>
                    )}
                    {site.override === "exempt" && (
                      <Badge variant="outline">예외</Badge>
                    )}
                    {site.supporter && <Badge variant="outline">후원자</Badge>}
                    {site.overrideReason && (
                      <span className="text-xs text-muted-foreground">
                        {site.overrideReason}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <SiteOverrideButtons
                      login={site.login}
                      override={site.override}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Card className="space-y-4 p-4">
        <div className="space-y-1">
          <h3 className="font-bold">WAF 사용자 규칙</h3>
          <p className="text-sm text-muted-foreground">
            Cloudflare가 위에서부터 적용해요. 무료 플랜은 규칙을 5개까지 둘 수
            있어요. 조건식은{" "}
            <a
              href="https://developers.cloudflare.com/ruleset-engine/rules-language/"
              className="underline"
              target="_blank"
              rel="noreferrer"
            >
              Cloudflare 규칙 언어
            </a>
            로 적어요.
          </p>
        </div>
        {rulesError ? (
          <p className="text-sm text-destructive">{rulesError}</p>
        ) : (
          <ul className="divide-y divide-border">
            {rules.length === 0 && (
              <li className="py-4 text-center text-sm text-muted-foreground">
                규칙이 없어요.
              </li>
            )}
            {rules.map((rule) => {
              const managed = rule.ref === SITE_LIMIT_RULE_REF;
              return (
                <li key={rule.id} className="space-y-2 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">
                          {rule.description || "(설명 없음)"}
                        </span>
                        <Badge variant="outline">
                          {RULE_ACTION_LABELS[rule.action] ?? rule.action}
                        </Badge>
                        {!rule.enabled && <Badge variant="outline">꺼짐</Badge>}
                        {managed && <Badge>요청 한도가 관리</Badge>}
                      </div>
                      <code className="block break-all text-xs text-muted-foreground">
                        {rule.expression}
                      </code>
                    </div>
                    {!managed && (
                      <RuleButtons
                        id={rule.id}
                        enabled={rule.enabled}
                        description={rule.description ?? ""}
                      />
                    )}
                  </div>
                  {!managed && (
                    <details className="text-sm">
                      <summary className="cursor-pointer text-muted-foreground">
                        고치기
                      </summary>
                      <div className="pt-2">
                        <RuleForm
                          id={rule.id}
                          initial={{
                            description: rule.description ?? "",
                            expression: rule.expression,
                            action: rule.action,
                          }}
                        />
                      </div>
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {!rulesError && (
          <div className="space-y-2 border-t border-border pt-4">
            <h4 className="text-sm font-bold">규칙 추가</h4>
            <RuleForm />
          </div>
        )}
      </Card>
    </div>
  );
}
