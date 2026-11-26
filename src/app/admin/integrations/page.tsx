import { redirect } from "next/navigation";
import { movedTo } from "@/lib/settings-areas";

export const dynamic = "force-dynamic";

/**
 * Settings → Integrations until 2026-11-26: social sign-in, Turnstile, IndexNow, verification, analytics and ads, Search
 * Console & GA4, image and video generation, Hybrid RAG and the SEO agent. Each is a section of the Settings area now (lib/settings-areas.ts OLD_ADDRESSES).
 * Kept so bookmarks, old links and e-mails still open the right form.
 */
export default async function OldIntegrationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  redirect(movedTo("/admin/integrations", await searchParams));
}
