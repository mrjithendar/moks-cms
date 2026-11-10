import type { Metadata } from "next";
import type { ReactNode } from "react";
import { NewsNav } from "@/components/news/NewsNav";
import { ensureNewsDefaults } from "@/lib/news/service";
import { newsDeskEnabled } from "@/lib/news/schema";
import { requireRole } from "@/lib/session";
import "../seo/seo.css";

export const metadata: Metadata = { title: { default: "News desk", template: "%s · News desk · Admin" }, robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/** /admin/news/* is admin-only. The kill switch banner shows on every page while NEWS_DESK_ENABLED is off. */
export default async function NewsLayout({ children }: { children: ReactNode }) {
  await requireRole("admin");
  await ensureNewsDefaults().catch(() => undefined);
  const on = newsDeskEnabled();
  return (
    <div>
      <NewsNav />
      {!on && (
        <p role="status" className="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
          The news desk is switched off (<code>NEWS_DESK_ENABLED</code> is not <code>true</code>). You can configure jobs, sources and profiles; nothing runs until it is switched on (docs/news/MANUAL_SETUP.md).
        </p>
      )}
      {children}
    </div>
  );
}
