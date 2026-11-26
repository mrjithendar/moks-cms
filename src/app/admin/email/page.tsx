import { redirect } from "next/navigation";
import { movedTo } from "@/lib/settings-areas";

export const dynamic = "force-dynamic";

/**
 * Settings → Email until 2026-11-26 (provider, test message). Both are sections of Settings → Email now (lib/settings-areas.ts OLD_ADDRESSES).
 * Kept so bookmarks, old links and e-mails still open the right form.
 */
export default async function OldEmailPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  redirect(movedTo("/admin/email", await searchParams));
}
