"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export type AdminSection = { href: string; label: string };
export type AdminSectionGroup = {
  label: string | null;
  sections: AdminSection[];
};

function isActive(href: string, pathname: string) {
  return href === "/admin"
    ? pathname === "/admin"
    : pathname === href || pathname.startsWith(`${href}/`);
}

function Sections({
  groups,
  pathname,
}: {
  groups: AdminSectionGroup[];
  pathname: string;
}) {
  return (
    <div className="space-y-4 px-2 pb-4">
      {groups.map((group, i) => (
        <div key={group.label ?? i} className="space-y-0.5">
          {group.label ? (
            <div className="px-2 pb-1 text-xs font-semibold text-muted-foreground">
              {group.label}
            </div>
          ) : null}
          {group.sections.map((section) => {
            const active = isActive(section.href, pathname);
            return (
              <Link
                key={section.href}
                href={section.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "block border-l-[3px] border-transparent px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                  active &&
                    "border-primary bg-accent font-bold text-foreground",
                )}
              >
                {section.label}
              </Link>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// A sidebar on wide screens; on a phone, a menu under the header that names
// the current section and closes on navigation (it is keyed by the path).
export function AdminNav({ groups }: { groups: AdminSectionGroup[] }) {
  const pathname = usePathname();
  const current = groups
    .flatMap((group) => group.sections)
    .find((section) => isActive(section.href, pathname));
  return (
    <nav>
      <details
        key={pathname}
        className="group border-t border-border lg:hidden"
      >
        <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-2.5 text-sm font-semibold [&::-webkit-details-marker]:hidden">
          {current?.label ?? "메뉴"}
          <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" />
        </summary>
        <Sections groups={groups} pathname={pathname} />
      </details>
      <div className="hidden lg:block">
        <Sections groups={groups} pathname={pathname} />
      </div>
    </nav>
  );
}
