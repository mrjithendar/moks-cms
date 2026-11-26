import { LocalTime } from "@/components/LocalTime";
import { RuntimeSettings } from "@/components/admin/RuntimeSettings";
import { Card, StatusPill } from "@/components/admin/ui";
import { Alert, Button, Field, Input } from "@/components/ui/form";
import { adminActor } from "@/lib/admin";
import { audit } from "@/lib/audit";
import { flash } from "@/lib/flash";
import { reportError } from "@/lib/http-errors";
import { PostError } from "@/lib/posts";
import { RagError } from "@/lib/rag/client";
import { queueRagReindex, ragStatus, searchPublished, type RagHit } from "@/lib/rag/sync";
import { settingsCategoryHref, settingsHref } from "@/lib/settings-areas";

async function ragReindexAction() {
  "use server";
  const actor = await adminActor();
  await flash(settingsHref("rag"), async () => {
    const r = await queueRagReindex();
    if (!r) throw new PostError("Hybrid RAG is off: save a bearer token first.");
    await audit(actor, "integrations.rag.reindex", undefined, r);
    return `${r.queued} of ${r.total} posts queued for Hybrid RAG${r.queued < r.total ? " (the others were already waiting)" : ""}. Published posts are indexed and all others removed, in the background over the next minutes.`;
  });
}

/**
 * Settings → Integrations → Hybrid RAG (Settings → Integrations until 2026-11-26): the connection (a runtime-settings
 * group), then lib/rag/sync.ts: where posts go, how the background sync is doing, the backfill and a test search.
 */
export default async function RagSection(query: Record<string, string | undefined> = {}) {
  const q = query.q?.trim().slice(0, 500) ?? "";
  return (
    <>
      {await RuntimeSettings({ ids: ["rag"], layout: "section" })}
      {await RagSync({ query: q })}
    </>
  );
}

async function RagSync({ query }: { query: string }) {
  const status = await ragStatus();
  const jobs = status.jobs;
  let hits: RagHit[] | null = null;
  let searchError: string | null = null;
  if (query && status.config) {
    try {
      hits = await searchPublished(query, { limit: 10 });
    } catch (error) {
      searchError = error instanceof RagError ? error.message : "The search failed. The error has been logged.";
      if (!(error instanceof RagError)) reportError("rag test search failed", error, { route: settingsCategoryHref("integrations"), dependency: "rag-api" });
    }
  }
  return (
    <section aria-labelledby="rag-sync-title" className="space-y-4">
      <Card>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h3 id="rag-sync-title" className="font-semibold text-fg">Sync</h3>
          <StatusPill status={status.config ? (status.lastFailure && (jobs.failed ?? 0) > 0 ? "degraded" : "ok") : "not configured"} />
        </div>
        {status.config ? (
          <p className="mb-4 text-sm text-fg-muted">
            Sends to <code>{status.config.url}</code>, collection <code>{status.config.collection}</code>, as <code>{status.config.serviceName}</code>. Last 7 days:{" "}
            {jobs.done ?? 0} synced, {(jobs.queued ?? 0) + (jobs.running ?? 0)} waiting, {jobs.failed ?? 0} failed.
            {status.lastDoneAt && <> Last sync {<LocalTime iso={status.lastDoneAt} />}.</>}
          </p>
        ) : (
          <p className="mb-4 text-sm text-fg-muted">Off: nothing is sent until a bearer token is saved above or set as RAG_BEARER_TOKEN in the deployment.</p>
        )}
        {status.lastFailure && (jobs.failed ?? 0) > 0 && (
          <div className="mb-4">
            <Alert>Last failed sync ({<LocalTime iso={status.lastFailure.at} />}): {status.lastFailure.error} Reindex all posts sends every post again.</Alert>
          </div>
        )}
        <form action={ragReindexAction}>
          <Button type="submit" variant="secondary" disabled={!status.config}>Reindex all posts</Button>
        </form>
        <p className="mt-2 text-xs text-fg-subtle">The backfill: indexes every published post and removes every other post from the collection. Posts deleted before Hybrid RAG was on cannot be found and stay until rag-api removes them.</p>
      </Card>
      <Card>
        <h3 className="mb-2 font-semibold text-fg">Test search</h3>
        <form method="get" action={settingsCategoryHref("integrations")} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="section" value="rag" />
          <div className="min-w-0 flex-1 basis-60">
            <Field label="Search published posts by meaning" htmlFor="rag-q" hint="Hybrid search (meaning and keywords) in the collection, published posts only. No AI answer is generated.">
              <Input id="rag-q" name="q" defaultValue={query} maxLength={500} disabled={!status.config} />
            </Field>
          </div>
          <Button type="submit" variant="secondary" disabled={!status.config}>Search</Button>
        </form>
        {searchError && <div className="mt-4"><Alert>{searchError}</Alert></div>}
        {hits && (
          hits.length === 0 ? (
            <p className="mt-4 text-sm text-fg-muted">No published post matches.</p>
          ) : (
            <ol className="mt-4 space-y-3">
              {hits.map((h) => (
                <li key={h.docId} className="text-sm">
                  {h.url ? <a href={h.url} target="_blank" rel="noopener" className="link font-medium">{h.title}</a> : <span className="font-medium text-fg">{h.title}</span>}{" "}
                  <span className="text-xs text-fg-subtle">score {h.score.toFixed(3)}</span>
                  <p className="mt-1 line-clamp-2 text-fg-muted">{h.snippet}</p>
                </li>
              ))}
            </ol>
          )
        )}
      </Card>
    </section>
  );
}
