"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/admin/content/sources", label: "Content sources" },
  { href: "/admin/content/topics", label: "Topics" },
  { href: "/admin/content/profiles", label: "Profiles & playground" },
  { href: "/admin/content/analytics", label: "Content analytics" },
  { href: "/admin/crewai/jobs", label: "Jobs ↗" },
];

/** Tabs for /admin/content/*: what every crew job writes from (horizontally scrollable on phones). */
export function ContentNav() {
  const path = usePathname();
  return (
    <nav aria-label="Content" className="-mx-4 mb-6 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:px-0">
      <ul className="flex min-w-max gap-1">
        {TABS.map((t) => {
          const on = path.startsWith(t.href);
          return (
            <li key={t.href}>
              <Link href={t.href} aria-current={on ? "page" : undefined} className={`inline-flex min-h-11 items-center border-b-2 px-3 text-sm font-medium ${on ? "border-accent text-fg" : "border-transparent text-fg-muted hover:text-fg"}`}>
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
