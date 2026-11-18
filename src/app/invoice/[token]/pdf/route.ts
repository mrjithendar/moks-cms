import { clientIp } from "@/lib/client-ip";
import { handleErrors } from "@/lib/http-errors";
import { clientInvoice, invoicePdfFile } from "@/lib/invoices";
import { hit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * GET /invoice/{token}/pdf: the client downloads their invoice. The token in the address is the only credential
 * (32 random bytes, see lib/invoices.ts); a draft has no public address. The file is the copy stored in R2.
 */
export const GET = handleErrors("client invoice pdf", async (request: Request, { params }: { params: Promise<{ token: string }> }) => {
  // Generous for a person, pointless for anyone guessing tokens or running up storage reads.
  if (!(await hit(`invoice:pdf:${clientIp(request.headers) ?? "unknown"}`, 60, 3600))) return new Response("Too many downloads. Try again later.", { status: 429 });
  const found = await clientInvoice((await params).token);
  if (!found) return new Response("Not found", { status: 404, headers: { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" } });
  const file = await invoicePdfFile(found.row);
  return new Response(new Uint8Array(file.bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${file.filename}"`,
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex",
    },
  });
});
