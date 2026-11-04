"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BadgeCheck,
  ArrowUpRight,
  BarChart3,
  Bell,
  ChevronDown,
  Database,
  Github,
  Globe2,
  Globe,
  Heart,
  Images,
  LogOut,
  Settings,
  ShieldCheck,
  User,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const TRIGGER_CLASS =
  "inline-flex min-h-10 items-center gap-1.5 whitespace-nowrap px-3 md:px-3.5 text-[15px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground";

// The section the page is in: a bar along the nav's bottom rule.
const ACTIVE_CLASS =
  "font-bold text-foreground shadow-[inset_0_-4px_0_hsl(var(--primary))]";

function useActive(prefixes: string[]) {
  const pathname = usePathname();
  return prefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

// A top-level item in the site's nav bar; the menus share its look.
export function NavLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  const active = useActive([href]);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`${TRIGGER_CLASS} ${active ? ACTIVE_CLASS : ""}`}
    >
      {children}
    </Link>
  );
}

// A 7×6 pixel-art heart, drawn in whole pixels to match the logo.
const HEART_PIXELS = [
  ".XX.XX.",
  "XXXXXXX",
  "XXXXXXX",
  ".XXXXX.",
  "..XXX..",
  "...X...",
];

export function PixelHeart() {
  return (
    <svg
      viewBox="0 0 7 6"
      width={14}
      height={12}
      shapeRendering="crispEdges"
      className="shrink-0 fill-destructive"
      aria-hidden
    >
      {HEART_PIXELS.flatMap((row, y) =>
        [...row].map((pixel, x) =>
          pixel === "X" ? (
            <rect key={`${x},${y}`} x={x} y={y} width={1} height={1} />
          ) : null,
        ),
      )}
    </svg>
  );
}

// The 서포터 link for an account offered a free trial, claimed on /supporter.
// The bubble sits in the row, since the nav's scroller clips anything that
// floats outside it, and floating would cover the page. Its text is shorter
// below a wide screen, and on a narrow one it takes the name's room, to fit the row.
export function TrialNavLink({ days }: { days: number }) {
  return (
    <NavLink href="/supporter">
      <span className="max-lg:sr-only">서포터</span>
      <span className="relative ml-1 whitespace-nowrap border-2 max-xl:ml-0 max-xl:px-1 max-lg:-ml-2 border-line bg-sun px-1.5 text-xs font-semibold leading-5 text-sun-foreground">
        <span
          aria-hidden
          className="absolute -left-[5px] top-1/2 size-2 -translate-y-1/2 rotate-45 border-b-2 border-l-2 border-line bg-sun"
        />
        {days}일 무료<span className="max-xl:hidden"> 체험</span>
      </span>
    </NavLink>
  );
}

// The two ways to build a site, side by side and neither the default. Someone
// signed out comes back to the editor after signing up.
export function MakeMenu({ signedIn }: { signedIn: boolean }) {
  const active = useActive(["/files", "/ai"]);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={`${TRIGGER_CLASS} ${active ? ACTIVE_CLASS : ""} focus-visible:bg-accent focus-visible:text-foreground focus-visible:outline-none`}
      >
        만들기
        <ChevronDown
          size={14}
          strokeWidth={2.5}
          aria-hidden
          className="md:max-lg:hidden"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem asChild>
          <Link href={signedIn ? "/files" : "/signup?next=/files"}>
            직접 만들기
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/ai">AI로 만들기</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type ExtensionItem = {
  href: string;
  label: string;
  icon: React.ReactNode;
  enabled: boolean;
};

// Supporters get a menu of the paid features with a link to their supporter
// page; everyone else gets a 서포터 link, offering the free trial to an account
// that may have it (see the layout).
export function SupporterMenu({
  analytics,
  database,
  customDomains,
  githubDeploys,
}: {
  analytics: boolean;
  database: boolean;
  customDomains: boolean;
  githubDeploys: boolean;
}) {
  const items: ExtensionItem[] = [
    {
      href: "/analytics",
      label: "분석",
      icon: <BarChart3 size={16} />,
      enabled: analytics,
    },
    {
      href: "/database",
      label: "데이터베이스",
      icon: <Database size={16} />,
      enabled: database,
    },
    {
      href: "/media",
      label: "미디어 라이브러리",
      icon: <Images size={16} />,
      enabled: database,
    },
    {
      href: "/domains",
      label: "커스텀 도메인",
      icon: <Globe size={16} />,
      enabled: customDomains,
    },
    {
      href: "/github",
      label: "GitHub 배포",
      icon: <Github size={16} />,
      enabled: githubDeploys,
    },
  ];

  const active = useActive(["/supporter", ...items.map((item) => item.href)]);

  return (
    <DropdownMenu>
      {/* Closing the menu puts focus back here, even after a click, so
          focus shows as a fill and not as an outline around the section. */}
      <DropdownMenuTrigger
        className={`${TRIGGER_CLASS} ${active ? ACTIVE_CLASS : ""} focus-visible:bg-accent focus-visible:text-foreground focus-visible:outline-none`}
      >
        서포터
        <PixelHeart />
        <ChevronDown size={14} strokeWidth={2.5} aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="flex items-center gap-2">
          <BadgeCheck size={16} />
          서포터
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/supporter" className="flex items-center gap-2">
            <Heart size={16} />
            플랜 관리
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {items.map((item) =>
          item.enabled ? (
            <DropdownMenuItem key={item.href} asChild>
              <Link href={item.href} className="flex items-center gap-2">
                {item.icon}
                {item.label}
              </Link>
            </DropdownMenuItem>
          ) : (
            // Shown rather than hidden so the menu says what supporting adds.
            <DropdownMenuItem key={item.href} disabled>
              <span className="flex items-center gap-2">
                {item.icon}
                {item.label}
                <span className="text-xs">유료 기능</span>
              </span>
            </DropdownMenuItem>
          ),
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AccountMenu({
  loginName,
  paymentOperator,
}: {
  loginName: string;
  paymentOperator: boolean;
}) {
  async function logout() {
    try {
      const response = await fetch("/api/account/logout", { method: "POST" });
      if (response.ok) {
        window.location.href = "/";
      }
    } catch (error) {
      console.error("Logout error:", error);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="inline-flex min-h-11 items-center gap-2 whitespace-nowrap sm:px-3 text-[15px] font-semibold text-foreground transition-colors hover:bg-accent data-[state=open]:bg-accent">
        <User size={20} aria-hidden className="mx-2.5 sm:hidden" />
        <span className="sr-only sm:not-sr-only">{loginName}</span>
        <ChevronDown
          size={14}
          strokeWidth={2.5}
          aria-hidden
          className="hidden sm:block"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="flex items-center gap-2">
          <User size={16} />
          {loginName}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/account" className="flex items-center gap-2">
            <Settings size={16} />
            계정 관리
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/presence" className="flex items-center gap-2">
            <Globe2 size={16} />
            공개 설정
          </Link>
        </DropdownMenuItem>
        {paymentOperator && (
          <DropdownMenuItem asChild>
            <Link href="/admin" className="flex items-center gap-2">
              <ShieldCheck size={16} />
              운영
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={logout}>
          <span className="flex items-center gap-2">
            <LogOut size={16} />
            로그아웃
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// The person's own site, opened in a new tab: its address on a wide screen,
// a globe on a phone.
export function SiteLink({ url }: { url: string }) {
  const host = url.replace(/^https?:\/\//, "");
  return (
    <a
      href={url}
      target="_blank"
      aria-label={`내 사이트 ${host} 열기`}
      className="inline-flex min-h-11 min-w-11 items-center justify-center gap-2 text-foreground transition-colors hover:bg-accent lg:min-h-9 lg:border-2 lg:border-line lg:px-3"
    >
      <Globe size={20} className="lg:hidden" aria-hidden />
      <span className="hidden max-w-60 truncate font-mono text-[13px] lg:inline">
        {host}
      </span>
      <ArrowUpRight
        size={14}
        strokeWidth={2.5}
        className="hidden lg:block"
        aria-hidden
      />
    </a>
  );
}

// Board notifications, with how many are unread.
export function NotificationsLink({ unread }: { unread: number }) {
  const active = useActive(["/board/notifications"]);
  return (
    <Link
      href="/board/notifications"
      aria-label={unread > 0 ? `알림 ${unread}개` : "알림"}
      aria-current={active ? "page" : undefined}
      className="relative inline-flex h-11 w-11 items-center justify-center text-foreground transition-colors hover:bg-accent"
    >
      <Bell size={20} aria-hidden />
      {unread > 0 && (
        <span
          aria-hidden
          className="absolute right-1.5 top-1.5 min-w-4 border-2 border-line bg-sun px-0.5 text-center font-mono text-[10px] font-medium leading-3 text-sun-foreground"
        >
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </Link>
  );
}
