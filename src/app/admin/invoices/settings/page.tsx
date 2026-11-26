import { redirect } from "next/navigation";
import { movedTo } from "@/lib/settings-areas";

export const dynamic = "force-dynamic";

/**
 * Billing → Invoices → Settings until 2026-11-26. It is Settings → Payments & bookings → Invoices now (lib/settings-areas.ts OLD_ADDRESSES).
 * Kept so bookmarks, old links and e-mails still open the right form.
 */
export default async function OldInvoiceSettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  redirect(movedTo("/admin/invoices/settings", await searchParams));
}
