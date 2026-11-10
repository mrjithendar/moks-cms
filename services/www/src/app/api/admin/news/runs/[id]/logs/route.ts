import { json, SeoApiError, seoRoute, UUID } from "@/lib/seo-intel/http";
import { runLogs } from "@/lib/news/service";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * GET /api/admin/news/runs/{id}/logs — server-sent events while the run is going (level filter + search via query),
 * polling news_run_logs once a second; ends when the run finishes (or after 5 minutes; the page reconnects).
 * `?format=json&after=N` returns one page instead (used by tests and as the fallback).
 */
export const GET = seoRoute<{ id: string }>("news-run-logs", { rate: { max: 60, windowSeconds: 60 } }, async (req, ctx, p) => {
  if (!UUID.test(p.id)) throw new SeoApiError("Run not found.", 404, "not_found");
  const level = ctx.query.get("level");
  const search = ctx.query.get("q");
  let after = Number(ctx.query.get("after") ?? req.headers.get("last-event-id") ?? 0) || 0;
  if (ctx.query.get("format") === "json") return json({ logs: await runLogs(p.id, after, level, search) });
  const { getDb } = await import("@/db");
  const { sql } = await import("drizzle-orm");
  const { rowsOf } = await import("@/db/rows");
  const enc = new TextEncoder();
  const started = Date.now();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (s: string) => controller.enqueue(enc.encode(s));
      send("retry: 3000\n\n");
      try {
        for (;;) {
          if (req.signal.aborted) break;
          const rows = await runLogs(p.id, after, level, search);
          for (const r of rows) {
            after = r.id;
            send(`id: ${r.id}\nevent: log\ndata: ${JSON.stringify(r)}\n\n`);
          }
          const db = await getDb();
          const [run] = rowsOf<{ status: string }>(await db.execute(sql`select status from news_runs where id = ${p.id}`));
          send(`event: status\ndata: ${JSON.stringify({ status: run?.status ?? "unknown" })}\n\n`);
          if (!run || !["queued", "running"].includes(run.status) || Date.now() - started > 290_000) break;
          await new Promise((r) => setTimeout(r, 1000));
        }
      } finally {
        send("event: end\ndata: {}\n\n");
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no", "X-Robots-Tag": "noindex" } });
});
