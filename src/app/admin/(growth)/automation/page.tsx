import { redirect } from "next/navigation";
import { movedTo } from "@/lib/settings-areas";

export const dynamic = "force-dynamic";

/**
 * AI & SEO → Settings until 2026-11-26 ("Automation & AI" until 2026-11-21). Its sections are in the Settings area now,
 * under AI & models, SEO agent, Assistants and Search & SEO; old section ids (and the ids merged on 2026-11-23) open
 * the section that has them, with the rest of the query kept (&scope=day) (lib/settings-areas.ts OLD_ADDRESSES).
 * Kept so bookmarks, old links and e-mails still open the right form.
 */
export default async function OldAiSeoSettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  redirect(movedTo("/admin/automation", await searchParams));
}
