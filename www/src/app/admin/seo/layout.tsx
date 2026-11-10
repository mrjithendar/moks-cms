import type { Metadata } from "next";
import type { ReactNode } from "react";
import { BudgetBanner } from "@/components/seo/ClaudeUsage";
import { SeoNav } from "@/components/seo/SeoNav";
import { requireRole } from "@/lib/session";

export const metadata: Metadata = { title: { default: "SEO intelligence", template: "%s · SEO · Admin" }, robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/** /admin/seo/* is admin-only (authors are redirected by requireRole). */
export default async function SeoLayout({ children }: { children: ReactNode }) {
  await requireRole("admin");
  return (
    <>
      <SeoNav />
      <BudgetBanner />
      {children}
    </>
  );
}
