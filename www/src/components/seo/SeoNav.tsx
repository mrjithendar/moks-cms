"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SEO_SECTIONS } from "./sections";

/** Section tabs for /admin/seo (scrolls sideways on small screens; keyboard-accessible links). */
export function SeoNav() {
  const pathname = usePathname();
  const active = (href: string) => (href === "/admin/seo" ? pathname === href : pathname.startsWith(href));
  return (
    <nav aria-label="SEO sections" className="-mx-1 mb-6 overflow-x-auto pb-1">
      <ul className="flex min-w-max gap-1 px-1">
        {SEO_SECTIONS.map((s) => (
          <li key={s.href}>
            <Link
              href={s.href}
              aria-current={active(s.href) ? "page" : undefined}
              className={`inline-flex min-h-9 items-center rounded-md px-3 text-sm font-medium ${active(s.href) ? "bg-accent-soft text-accent-text" : "text-fg-muted hover:bg-surface-sunken hover:text-fg"}`}
            >
              {s.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
