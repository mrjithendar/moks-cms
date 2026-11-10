import { sql } from "drizzle-orm";
import type { Metadata } from "next";
import { Suspense, type ReactNode } from "react";
import { getDb } from "@/db";
import { rowsOf } from "@/db/rows";
import { BudgetBanner } from "@/components/seo/ClaudeUsage";
import { SeoShell, type SyncPill } from "@/components/seo/SeoShell";
import { sourceStatus } from "@/lib/seo-intel/queries";
import { getSeoSettings } from "@/lib/seo-intel/settings";
import { requireRole } from "@/lib/session";
import "./seo.css";

export const metadata: Metadata = { title: { default: "SEO intelligence", template: "%s · SEO · Admin" }, robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

const ago = (iso: string | null) => {
  if (!iso) return "never";
  const h = Math.round((Date.now() - Date.parse(iso)) / 3_600_000);
  return h < 1 ? "just now" : h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
};

async function shellData(): Promise<{ reviewCount: number; property: string | null; sync: SyncPill }> {
  try {
    const db = await getDb();
    const s = await getSeoSettings();
    const [gsc, ga4] = await Promise.all([sourceStatus(db, s, "gsc"), sourceStatus(db, s, "ga4")]);
    const order = ["error", "stale", "never_synced", "disconnected", "ok"] as const;
    const worst = [gsc, ga4].sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state))[0]!;
    const [n] = rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from seo_drafts where status = 'ready_for_review'`));
    const label = worst.state === "ok" ? `Synced ${ago(gsc.lastSuccessAt)}` : worst.state === "stale" ? "Stale data" : worst.state === "error" ? "Sync error" : worst.state === "never_synced" ? "Not synced yet" : "Not connected";
    return { reviewCount: Number(n?.n ?? 0), property: s.google.gscProperty || null, sync: { state: worst.state, label, detail: `${gsc.message} ${ga4.message}` } };
  } catch {
    return { reviewCount: 0, property: null, sync: { state: "error", label: "Status unavailable", detail: "" } };
  }
}

/** /admin/seo/* is admin-only (authors are redirected by requireRole). */
export default async function SeoLayout({ children }: { children: ReactNode }) {
  await requireRole("admin");
  const shell = await shellData();
  return (
    <Suspense>
      <SeoShell {...shell}>
        <BudgetBanner />
        {children}
      </SeoShell>
    </Suspense>
  );
}
