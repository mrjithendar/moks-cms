import { activeOperation, describeRun, operation } from "@/lib/backup/service";
import { handleErrors } from "@/lib/http-errors";
import { getSessionUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * The backup operation that is waiting or running now (or `?id=` one operation), for the progress panel of Admin →
 * Backups, which asks every few seconds while something runs. Admins only; it says what runs and how far it is, never
 * what the backup holds.
 */
export const GET = handleErrors("backup status", async (request?: Request) => {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") return Response.json({ error: "forbidden" }, { status: 403 });
  const id = request ? new URL(request.url).searchParams.get("id") : null;
  const r = id ? await operation(id) : await activeOperation();
  const body = r
    ? {
        id: r.id,
        operation: r.operation,
        label: describeRun(r),
        status: r.status,
        progress: r.progress,
        filename: r.filename,
        startedAt: r.startedAt.toISOString(),
        finishedAt: r.finishedAt?.toISOString() ?? null,
        error: r.error,
        cancelRequested: r.cancelRequested,
      }
    : null;
  return Response.json({ operation: body }, { headers: { "Cache-Control": "no-store" } });
});
