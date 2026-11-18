import { actorOf } from "@/lib/admin";
import { audit } from "@/lib/audit";
import { buildBackup, plainCopyOfStoredBackup } from "@/lib/backups";
import { handleErrors } from "@/lib/http-errors";
import { PostError } from "@/lib/posts";
import { getSessionUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Download a fresh backup, or `?file=` one stored in R2 (admins only), always as an unencrypted zip the owner can open:
 * stored backups are encrypted with the server key (no passphrase), which nobody holds outside the server.
 */
export const GET = handleErrors("backup download", async (request?: Request) => {
  const user = await getSessionUser();
  // A backup is the whole database: never for a demo account, even though it otherwise sees what an admin sees.
  if (!user || user.role !== "admin" || user.demo) return new Response("Forbidden", { status: 403 });
  try {
    const stored = request ? new URL(request.url).searchParams.get("file") : null;
    const { filename, data } = stored ? { filename: stored.replace(/\.json\.gz\.enc$/, ".zip"), data: await plainCopyOfStoredBackup(stored) } : await buildBackup({ plain: true });
    await audit(actorOf(user), "backup.download", filename, { stored: Boolean(stored), unencrypted: true });
    return new Response(new Uint8Array(data), {
      headers: {
        "Content-Type": filename.endsWith(".zip") ? "application/zip" : "application/octet-stream",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof PostError) return new Response(error.message, { status: error.status ?? 400 });
    throw error;
  }
});
