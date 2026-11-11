import type { Metadata } from "next";
import { Suspense, type ReactNode } from "react";
import { BudgetBanner } from "@/components/seo/ClaudeUsage";
import { SeoShell } from "@/components/seo/SeoShell";
import { requireRole } from "@/lib/session";

export const metadata: Metadata = { title: { default: "Admin", template: "%s · Admin" }, robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/**
 * Search, analytics, editorial calendar, review and automation pages: ordinary CMS admin pages (this route group adds
 * no URL prefix; navigation is the main admin sidebar). Admin-only (authors are redirected by requireRole).
 */
export default async function GrowthLayout({ children }: { children: ReactNode }) {
  await requireRole("admin");
  return (
    <Suspense>
      <SeoShell>
        <BudgetBanner />
        {children}
      </SeoShell>
    </Suspense>
  );
}
