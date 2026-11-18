import { flowLabel } from "@/lib/crewai/flows";
import { logLineText } from "@/lib/crewai/format";
import { runDetail, runLogs, runStatus } from "@/lib/crewai/runs";
import { json, SeoApiError, seoRoute, UUID } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * GET /api/admin/crewai/runs/{id}/logs — the run's log.
 * - Default: server-sent events while the run is going (`log` events, a `status` event each second, then `end`), from
 *   `after` (or Last-Event-ID), polling seo_flow_run_logs once a second; ends when the run finishes or after ~5 minutes
 *   (the browser reconnects where it stopped).
 * - `?format=json&after=N`: one page of lines (500).
 * - `?format=text`: the whole log as a text file (the "Download log" link), up to 20,000 lines.
 * `level` (debug | info | warning | error: that level and above) and `q` (text) filter on the server.
 */
export const GET = seoRoute<{ id: string }>("crewai-run-logs", { rate: { max: 120, windowSeconds: 60 } }, async (req, ctx, p) => {
  if (!UUID.test(p.id)) throw new SeoApiError("Run not found.", 404, "not_found");
  const level = ctx.query.get("level");
  const q = ctx.query.get("q");
  let after = Number(ctx.query.get("after") ?? req.headers.get("last-event-id") ?? 0) || 0;
  const format = ctx.query.get("format");
  if (format === "json") return json({ logs: await runLogs(p.id, after, { level, q }) });
  if (format === "text") {
    const run = await runDetail(p.id);
    if (!run) throw new SeoApiError("Run not found.", 404, "not_found");
    const lines = await runLogs(p.id, 0, { level, q, limit: 20_000 });
    const head = `# ${flowLabel(run.flow)} #${run.number ?? "?"} (${run.flow}) run ${run.runId}\n# status ${run.status} · trigger ${run.triggeredBy} · started ${run.startedAt}${run.finishedAt ? ` · finished ${run.finishedAt}` : ""}\n`;
    const body = head + lines.map((l) => logLineText(l) + (l.context.exc ? `\n${String(l.context.exc)}` : "")).join("\n") + "\n";
    return new Response(body, {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": `attachment; filename="${run.flow}-${run.number ?? run.runId.slice(0, 8)}.log"`, "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
    });
  }
  const enc = new TextEncoder();
  const started = Date.now();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (s: string) => controller.enqueue(enc.encode(s));
      send("retry: 3000\n\n");
      try {
        for (;;) {
          if (req.signal.aborted) break;
          const rows = await runLogs(p.id, after, { level, q });
          for (const r of rows) {
            after = r.id;
            send(`id: ${r.id}\nevent: log\ndata: ${JSON.stringify(r)}\n\n`);
          }
          const status = await runStatus(p.id);
          send(`event: status\ndata: ${JSON.stringify({ status: status ?? "unknown" })}\n\n`);
          // A finished run: one more read picks up the lines the agent wrote with the final status.
          if (!status || !["queued", "running"].includes(status)) {
            if (rows.length === 0) break;
            continue;
          }
          if (Date.now() - started > 290_000) break;
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
