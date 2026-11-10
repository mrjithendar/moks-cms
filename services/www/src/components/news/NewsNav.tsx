"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/admin/news", label: "Jobs" },
  { href: "/admin/news/runs", label: "Run history" },
  { href: "/admin/news/sources", label: "Sources" },
  { href: "/admin/news/profiles", label: "Profiles & playground" },
  { href: "/admin/news/topics", label: "Topics" },
  { href: "/admin/news/analytics", label: "Analytics" },
  { href: "/admin/news/settings", label: "Settings" },
  { href: "/admin/seo/review?tab=news", label: "Review queue ↗" },
];

/** Section tabs for /admin/news (horizontally scrollable on phones). */
export function NewsNav() {
  const path = usePathname();
  const active = (href: string) => (href === "/admin/news" ? path === href || path.startsWith("/admin/news/jobs") : path.startsWith(href.split("?")[0]!));
  return (
    <nav aria-label="News desk" className="-mx-4 mb-6 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:px-0">
      <ul className="flex min-w-max gap-1">
        {TABS.map((t) => (
          <li key={t.href}>
            <Link href={t.href} aria-current={active(t.href) ? "page" : undefined} className={`inline-flex min-h-11 items-center border-b-2 px-3 text-sm font-medium ${active(t.href) ? "border-accent text-fg" : "border-transparent text-fg-muted hover:text-fg"}`}>
              {t.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
