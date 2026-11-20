import { desc, like } from "drizzle-orm";
import { Flash, type FlashParams } from "@/components/admin/Flash";
import { AdminHeader, Card, Stat, StatusPill, Table, td, th } from "@/components/admin/ui";
import { Button, Field, Input } from "@/components/ui/form";
import { getDb, schema } from "@/db";
import { adminActor } from "@/lib/admin";
import { CACHE_ACTIONS, type CacheAction } from "@/lib/admin-bar";
import { cacheStatus, runCacheAction } from "@/lib/cache-admin";
import { flash } from "@/lib/flash";
import { PAGE_REVALIDATE_SECONDS } from "@/lib/page-cache";
import { requireRole } from "@/lib/session";

export const metadata = { title: "Cache" };
export const dynamic = "force-dynamic";

const BACK = "/admin/cache";

async function act(form: FormData) {
  "use server";
  const actor = await adminActor();
  const action = String(form.get("action") ?? "") as CacheAction;
  await flash(BACK, async () => {
    if (!CACHE_ACTIONS.includes(action)) throw new Error("unknown cache action");
    return runCacheAction(actor, action, form.get("path") ?? undefined);
  });
}

const ACTION_LABELS: Record<string, string> = {
  "cache.purge.page": "Purged a page",
  "cache.clear.pages": "Cleared the page cache",
  "cache.clear.data": "Reloaded content & settings",
  "cache.purge.all": "Purged all caches",
};

function mb(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default async function CachePage({ searchParams }: { searchParams: FlashParams }) {
  const me = await requireRole("admin");
  const db = await getDb();
  const [sp, recent] = await Promise.all([
    searchParams,
    db
      .select({ at: schema.auditLog.createdAt, actor: schema.auditLog.actor, action: schema.auditLog.action, target: schema.auditLog.target })
      .from(schema.auditLog)
      .where(like(schema.auditLog.action, "cache.%"))
      .orderBy(desc(schema.auditLog.createdAt))
      .limit(15),
  ]);
  const s = cacheStatus();
  const busOk = s.bus.state === "connected";
  const off = Boolean(me.demo);
  return (
    <>
      <AdminHeader
        title="Cache"
        description="Public pages are rendered once and served from memory, so readers get them fast. Every change you make in the admin already clears what it affects; use these when something changed elsewhere, or to see a fresh copy now. The same tools are in the admin bar's Cache menu."
      />
      <Flash ok={sp.ok} error={sp.error} />
      <div className="space-y-6">
        <Card>
          <h2 className="mb-1 font-semibold text-fg">Clear caches</h2>
          <p className="mb-4 text-sm text-fg-muted">Each action runs on every server of the site at once{busOk ? "" : " when the cache bus is connected (below); right now only the server that answers clears its copy, and the others catch up within their refresh time"}.</p>
          <div className="grid gap-4 lg:grid-cols-2">
            <form action={act} className="flex flex-wrap items-end gap-3 rounded-lg border border-line p-4 lg:col-span-2">
              <input type="hidden" name="action" value="purge-page" />
              <div className="min-w-64 flex-1">
                <Field label="Page address" htmlFor="path" hint="A page of this site, e.g. /blog/my-post or / for the home page.">
                  <Input id="path" name="path" required placeholder="/blog/my-post" pattern="/.*" maxLength={512} />
                </Field>
              </div>
              <Button type="submit" variant="secondary" disabled={off}>Purge this page</Button>
            </form>
            <ActionCard action="clear-pages" title="Clear page cache" text="Every page is rendered again on its next visit; the site re-renders them in the background within seconds." off={off} />
            <ActionCard action="clear-data" title="Reload content & settings" text="Posts, pages, categories, menus, appearance and integrations are read again from the database, and the page cache is cleared." off={off} />
            <ActionCard action="purge-all" title="Purge all caches" text="Everything above, at once." off={off} primary />
          </div>
        </Card>

        <section aria-labelledby="this-server">
          <h2 id="this-server" className="mb-1 font-semibold text-fg">This server</h2>
          <p className="mb-3 text-sm text-fg-muted">
            Each server keeps its own page cache; these numbers are for <code>{s.pod}</code>, the one that answered this request.
          </p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Pages cached" value={s.pages} />
            <Stat label="Memory used" value={mb(s.bytes)} hint={`of ${mb(s.maxBytes)} (PAGE_CACHE_MAX_MB)`} />
            <Stat label="Served from cache" value={s.hitRate === null ? "—" : `${Math.round(s.hitRate * 100)}%`} hint={`${s.lookups} lookups since start`} />
            <Stat label="Cleared since start" value={s.clears} hint="Publishes, setting changes and clears" />
          </div>
        </section>

        <Card>
          <div className="mb-2 flex items-center justify-between gap-3">
            <h2 className="font-semibold text-fg">Cache bus</h2>
            <StatusPill status={busOk ? "ok" : s.bus.state === "not configured" ? "not configured" : "degraded"} />
          </div>
          <p className="text-sm text-fg-muted">
            Carries every clear to the other servers over Redis/Valkey ({s.bus.source ?? "CACHE_BUS_REDIS_URL not set"}). Without it, other servers refresh a page at the latest {PAGE_REVALIDATE_SECONDS / 60} minutes after it changed.
          </p>
        </Card>

        <section aria-labelledby="recent">
          <h2 id="recent" className="mb-3 font-semibold text-fg">Recent cache actions</h2>
          {recent.length === 0 ? (
            <p className="text-sm text-fg-muted">None yet. Every action is also in the Audit log.</p>
          ) : (
            <Table head={<tr><th className={th}>When (UTC)</th><th className={th}>Who</th><th className={th}>What</th><th className={th}>Page</th></tr>}>
              {recent.map((r, i) => (
                <tr key={i}>
                  <td className={`${td} whitespace-nowrap font-mono text-xs`}>{r.at.toISOString().slice(0, 16).replace("T", " ")}</td>
                  <td className={td}>{r.actor}</td>
                  <td className={td}>{ACTION_LABELS[r.action] ?? r.action}</td>
                  <td className={`${td} min-w-40 font-mono text-xs [overflow-wrap:anywhere]`}>{r.target ?? "—"}</td>
                </tr>
              ))}
            </Table>
          )}
        </section>
      </div>
    </>
  );
}

function ActionCard({ action, title, text, off, primary = false }: { action: CacheAction; title: string; text: string; off: boolean; primary?: boolean }) {
  return (
    <form action={act} className="flex flex-col justify-between gap-3 rounded-lg border border-line p-4">
      <input type="hidden" name="action" value={action} />
      <div>
        <h3 className="font-medium text-fg">{title}</h3>
        <p className="mt-1 text-sm text-fg-muted">{text}</p>
      </div>
      <div>
        <Button type="submit" variant={primary ? "primary" : "secondary"} disabled={off}>{title}</Button>
      </div>
    </form>
  );
}
