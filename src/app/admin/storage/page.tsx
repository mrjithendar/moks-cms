import { redirect } from "next/navigation";
import { movedTo } from "@/lib/settings-areas";

export const dynamic = "force-dynamic";

/**
 * Settings → Media & storage until 2026-11-26 (media storage, video destinations, moving media to R2). Each is a section
 * of Settings → Media & storage now (lib/settings-areas.ts OLD_ADDRESSES).
 * Kept so bookmarks, old links and e-mails still open the right form.
 */
export default async function OldStoragePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  redirect(movedTo("/admin/storage", await searchParams));
}
