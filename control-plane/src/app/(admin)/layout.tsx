import type { Metadata } from "next";
import { Suspense } from "react";
import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import "../(main)/globals.css";
import { fontVariables } from "../fonts";
import { validateRequest } from "@/lib/auth";
import { PAYMENT_OPERATOR_USERS } from "@/lib/payments/support";
import { isTossTestMode } from "@/lib/payments/toss";
import { ThemeProvider } from "@/components/theme-provider";
import { ConfirmProvider } from "@/components/ui/confirm";
import { Toaster } from "@/components/ui/sonner";
import { ModeToggle } from "@/components/ModeToggle";
import { LoadingBar } from "@/components/LoadingBar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search } from "lucide-react";
import { AdminNav, type AdminSectionGroup } from "./admin/_components/AdminNav";

export const metadata: Metadata = { title: "운영 · 나루" };

// The operators' pages have their own root layout, not the site's: a sidebar
// of sections in place of the site's navigation and footer. Every /admin page
// is for operators only; the pages check again on their own, since a layout
// does not re-run on every navigation.
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user } = await validateRequest();
  if (!user || !PAYMENT_OPERATOR_USERS.has(user.loginName)) {
    redirect("/account");
  }

  const groups: AdminSectionGroup[] = [
    { label: null, sections: [{ href: "/admin", label: "개요" }] },
    {
      label: "이용자",
      sections: [
        { href: "/admin/users", label: "계정" },
        { href: "/admin/moderation", label: "사이트 관리" },
        { href: "/admin/domains", label: "커스텀 도메인" },
        { href: "/admin/supporters", label: "유료 이용자" },
        { href: "/admin/trials", label: "무료 체험" },
        { href: "/admin/usage", label: "사용량" },
        { href: "/admin/board", label: "게시판" },
        { href: "/admin/templates", label: "템플릿 적용" },
      ],
    },
    {
      label: "결제",
      sections: [
        { href: "/admin/payments", label: "결제" },
        { href: "/admin/subscriptions", label: "정기 결제" },
        { href: "/admin/store-subscriptions", label: "앱 구독" },
        { href: "/admin/events", label: "결제 이벤트" },
        { href: "/admin/webhooks", label: "웹훅" },
        { href: "/admin/toss-calls", label: "Toss 호출" },
        { href: "/admin/records", label: "결제 기록" },
        { href: "/admin/billing-keys", label: "빌링키 삭제" },
        // The lab charges and refunds for real, so it exists only with test
        // keys.
        ...(isTossTestMode()
          ? [{ href: "/admin/lab", label: "결제 실험실" }]
          : []),
      ],
    },
    {
      label: "시스템",
      sections: [
        { href: "/admin/jobs", label: "예약 작업" },
        { href: "/admin/firewall", label: "방화벽" },
      ],
    },
  ];

  return (
    <html lang="ko" suppressHydrationWarning className={fontVariables}>
      <body>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <ConfirmProvider>
            {/* useSearchParams needs a Suspense boundary to keep static
              pages static. The bar hangs from this zero-height strip. */}
            <div className="fixed inset-x-0 top-0 z-50 h-0">
              <Suspense fallback={null}>
                <LoadingBar />
              </Suspense>
            </div>
            <div className="min-h-screen bg-background lg:flex">
              <aside className="border-b-2 border-line bg-card lg:sticky lg:top-0 lg:h-screen lg:w-56 lg:shrink-0 lg:overflow-y-auto lg:border-r-2 lg:border-b-0">
                <div className="flex items-center justify-between gap-2 px-4 py-3">
                  <Link href="/admin" className="flex items-center gap-2">
                    <Image
                      src="/logo.png"
                      alt=""
                      width={24}
                      height={24}
                      priority
                      className="[image-rendering:pixelated]"
                      style={{ filter: "var(--logo-filter, none)" }}
                    />
                    <span className="text-lg font-bold tracking-tight">
                      나루 운영
                    </span>
                  </Link>
                  <ModeToggle />
                </div>
                <form
                  action="/admin/users"
                  role="search"
                  className="flex gap-1 px-4 pb-3"
                >
                  <label htmlFor="admin-user-search" className="sr-only">
                    계정 아이디
                  </label>
                  <Input
                    id="admin-user-search"
                    name="user"
                    placeholder="계정 찾기"
                    className="h-8 min-w-0 flex-1 text-sm"
                  />
                  <Button
                    type="submit"
                    size="sm"
                    variant="outline"
                    aria-label="찾기"
                    className="h-8 px-2"
                  >
                    <Search className="h-4 w-4" />
                  </Button>
                </form>
                <AdminNav groups={groups} />
                <div className="hidden space-y-1 border-t border-border px-4 py-3 text-xs text-muted-foreground lg:block">
                  <div className="font-mono">{user.loginName}</div>
                  <Link href="/" className="underline">
                    사이트로 돌아가기
                  </Link>
                </div>
              </aside>
              <main className="min-w-0 flex-1 p-4 sm:p-6">{children}</main>
            </div>
            <Toaster />
          </ConfirmProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
