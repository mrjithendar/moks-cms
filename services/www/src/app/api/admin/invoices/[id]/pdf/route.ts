import { actorOf } from "@/lib/admin";
import { audit } from "@/lib/audit";
import { handleErrors } from "@/lib/http-errors";
import { getInvoice, invoicePdfFile } from "@/lib/invoices";
import { getSessionUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/invoices/{id}/pdf: the invoice as a PDF. A sent, paid or void invoice comes from R2 (rendered and
 * stored again if the stored copy is missing or older than the invoice's state); a draft is a preview rendered on the
 * spot. Admins only, and never a demo account: an invoice is a client's name, address and bill.
 */
export const GET = handleErrors("invoice pdf", async (_request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await getSessionUser();
  if (!user || user.role !== "admin" || user.demo) return new Response("Forbidden", { status: 403 });
  const row = await getInvoice((await params).id);
  if (!row) return new Response("Not found", { status: 404 });
  const file = await invoicePdfFile(row);
  await audit(actorOf(user), "invoice.download", row.id, { number: row.number, stored: file.stored });
  return new Response(new Uint8Array(file.bytes), {
    headers: {
      "Content-Type": "application/pdf",
      // A draft opens in the browser as a preview; a real invoice downloads under its number.
      "Content-Disposition": `${row.status === "draft" ? "inline" : "attachment"}; filename="${file.filename}"`,
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex",
    },
  });
});
