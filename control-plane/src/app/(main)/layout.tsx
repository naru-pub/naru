import type { Metadata } from "next";
import { Suspense } from "react";
import "./globals.css";
import { fontVariables } from "../fonts";
import Link from "next/link";
import { validateRequest } from "@/lib/auth";
import Image from "next/image";
import { Toaster } from "@/components/ui/sonner";
import { ConfirmProvider } from "@/components/ui/confirm";
import { getHomepageUrl } from "@/lib/site-urls";
import { ThemeProvider } from "@/components/theme-provider";
import { ModeToggle } from "@/components/ModeToggle";
import { LoadingBar } from "@/components/LoadingBar";
import { ImpersonationBanner } from "@/components/ImpersonationBanner";
import { PAYMENT_OPERATOR_USERS } from "@/lib/payments/support";
import { servedCustomDomains } from "@/lib/edge/domains";
import { installCounts } from "@/lib/board/updates";
import { countUnreadNotifications } from "@/lib/board/replies";
import {
  getUserEntitlement,
  featuresOf,
  type Feature,
} from "@/lib/entitlements";
import {
  AccountMenu,
  NavLink,
  NotificationsLink,
  PixelHeart,
  SiteLink,
  SupporterMenu,
  TrialNavLink,
} from "@/components/NavMenus";
import { db } from "@/lib/database";
import { TRIAL_DAYS, trialState } from "@/lib/supporter-trial";

export const metadata: Metadata = {
  title: "나루",
  description: "당신의 공간을 나루에 띄워 보세요.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const { user, session } = await validateRequest();
  const entitlement = user ? await getUserEntitlement(user.id) : null;
  const features = new Set<Feature>(entitlement ? featuresOf(entitlement) : []);
  // Also to an account that lacks only a verified email: /supporter asks for it.
  const offerTrial =
    user && !entitlement?.hasPaidFeatures
      ? ["eligible", "unverified"].includes(
          (await trialState(db, user.id)).state,
        )
      : false;
  // The address the site is visited at: its custom domain while the edge
  // serves it and its DNS reaches Naru, where the subdomain redirects, chosen
  // as the edge chooses.
  // The installed-templates page, for people who installed one, with how
  // many of their templates have a new version waiting.
  const installs = user ? await installCounts(user.id) : null;
  const unread = user ? await countUnreadNotifications(user.id) : null;
  const customDomain = user
    ? (await servedCustomDomains(user.id))
        .filter((d) => d.resolves)
        .map((d) => d.hostname)
        .sort()[0]
    : undefined;
  const siteUrl = user
    ? customDomain
      ? `https://${customDomain}`
      : getHomepageUrl(user.loginName)
    : null;

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
            <div className="bg-background h-screen flex flex-col">
              {session?.impersonatorSessionId && (
                <ImpersonationBanner loginName={user.loginName} />
              )}
              <nav className="relative bg-card border-b-2 border-line">
                <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                  {/* On a phone the links drop to a second row under the
                    logo and account controls. Each link's active bar sits
                    on the nav's bottom rule. */}
                  <div className="flex flex-wrap items-stretch gap-x-2 md:h-16 md:flex-nowrap md:gap-x-8">
                    <Link
                      href="/"
                      className="flex h-14 shrink-0 items-center gap-2.5 group md:h-auto"
                    >
                      <Image
                        src="/logo.png"
                        alt=""
                        width={32}
                        height={32}
                        priority
                        className="[image-rendering:pixelated] transition-transform duration-200 group-hover:-translate-y-0.5"
                        style={{
                          filter: "var(--logo-filter, none)",
                        }}
                      />
                      <span className="whitespace-nowrap text-2xl font-bold tracking-tight text-foreground">
                        나루
                      </span>
                    </Link>

                    {/* The scroller clips, so its padding (offset by the
                      negative margin) leaves room for the focus outline. */}
                    <div className="order-last -mx-4 flex h-11 w-[calc(100%+2rem)] items-stretch gap-0.5 overflow-x-auto border-t border-border px-2 pt-px [scrollbar-width:none] sm:-mx-6 sm:w-[calc(100%+3rem)] sm:px-4 md:order-none md:mx-0 md:h-auto md:w-auto md:border-0 md:px-0 md:pt-0 [&::-webkit-scrollbar]:hidden">
                      <NavLink href="/docs">길잡이</NavLink>
                      {user && <NavLink href="/files">파일</NavLink>}
                      <NavLink href="/board">자랑</NavLink>
                      <NavLink href="/templates">
                        템플릿
                        {installs && installs.updatable > 0 && (
                          <span
                            className="bg-primary px-1.5 font-mono text-xs leading-5 text-primary-foreground"
                            aria-label={`새 버전 ${installs.updatable}개`}
                          >
                            {installs.updatable}
                          </span>
                        )}
                      </NavLink>
                      {entitlement?.hasPaidFeatures ? (
                        <SupporterMenu
                          analytics={features.has("analytics")}
                          database={features.has("database")}
                          customDomains={features.has("custom_domains")}
                          githubDeploys={features.has("github_deploys")}
                        />
                      ) : offerTrial ? (
                        <TrialNavLink days={TRIAL_DAYS} />
                      ) : (
                        <NavLink href="/supporter">
                          서포터
                          <PixelHeart />
                        </NavLink>
                      )}
                    </div>

                    <div className="ml-auto flex shrink-0 items-center gap-1 md:gap-2">
                      {user ? (
                        <>
                          <SiteLink url={siteUrl!} />
                          <NotificationsLink unread={unread?.count ?? 0} />
                          <ModeToggle
                            variant="ghost"
                            className="h-11 w-11 hover:bg-accent"
                          />
                          <AccountMenu
                            loginName={user.loginName}
                            paymentOperator={PAYMENT_OPERATOR_USERS.has(
                              user.loginName,
                            )}
                          />
                        </>
                      ) : (
                        <>
                          <ModeToggle
                            variant="ghost"
                            className="h-11 w-11 hover:bg-accent"
                          />
                          <NavLink href="/login">로그인</NavLink>
                          <Link
                            href="/signup"
                            className="press mx-1 whitespace-nowrap border-2 border-line bg-primary px-3 py-1.5 text-[15px] font-semibold text-primary-foreground md:px-4"
                          >
                            회원가입
                          </Link>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                {/* useSearchParams needs a Suspense boundary to keep static
                  pages static. */}
                <Suspense fallback={null}>
                  <LoadingBar />
                </Suspense>
              </nav>

              <main className="flex-1 min-h-0">{children}</main>
            </div>
            <Toaster />
          </ConfirmProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
