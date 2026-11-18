import Link from "next/link";
import { Flash, type FlashParams } from "@/components/admin/Flash";
import { AdminHeader, Card, Stat, Table, td, th } from "@/components/admin/ui";
import { Button, Input, Select, Textarea } from "@/components/ui/form";
import { adminActor } from "@/lib/admin";
import { audit } from "@/lib/audit";
import { flash } from "@/lib/flash";
import { PostError } from "@/lib/posts";
import { AgentError, lanceBrowse, lanceDelete, lanceOverview, lanceRow, lanceUpdate, type LanceCell, type LanceColumn } from "@/lib/seo-agent/client";
import { requireRole } from "@/lib/session";

export const metadata = { title: "LanceDB" };
export const dynamic = "force-dynamic";

/**
 * The SEO agent's LanceDB (D-92): its tables, their rows, and one-row edits and deletes. LanceDB is embedded in
 * seo-agent (files on R2), so every call goes through its internal API (lib/seo-agent/client.ts → app/lance_admin.py),
 * which refuses anything but a single row picked by a unique key, and scalar columns only.
 */

const PAGE = 25;
const linkCls = "font-semibold text-brand-600 hover:underline dark:text-brand-300";
const pill = "rounded-lg border border-line-strong px-3 py-1.5";

type Sp = Awaited<FlashParams> & { table?: string; page?: string; key_column?: string; key?: string };

function href(p: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams(Object.entries(p).filter((e): e is [string, string | number] => e[1] !== undefined && e[1] !== "").map(([k, v]) => [k, String(v)]));
  return `/admin/lancedb${q.size ? `?${q}` : ""}`;
}

function show(v: LanceCell | undefined): string {
  if (v === null || v === undefined) return "∅";
  if (typeof v === "object") {
    if ("dims" in v) return `[${v.head.join(", ")}${v.dims > v.head.length ? ", …" : ""}] (${v.dims} dims)`;
    if ("items" in v) return `[${v.head.join(", ")}${v.items > v.head.length ? ", …" : ""}] (${v.items} items)`;
    return `${v.text}… (${v.length.toLocaleString()} chars)`;
  }
  return String(v);
}

/** The key column offered first: `id` if there is one, else the first editable column. */
function defaultKey(cols: LanceColumn[]): string | null {
  return (cols.find((c) => c.editable && c.name === "id") ?? cols.find((c) => c.editable && (c.kind === "string" || c.kind === "int")) ?? cols.find((c) => c.editable))?.name ?? null;
}

/** A form value as the type the column expects (the agent checks it again). */
function typed(raw: string, kind: LanceColumn["kind"]): string | number | boolean {
  if (kind === "bool") return raw === "true";
  if (kind === "int" && /^-?\d+$/.test(raw.trim())) return Number(raw.trim());
  return raw;
}

async function agent<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AgentError) throw new PostError(e.message, e.status);
    throw e;
  }
}

async function saveRow(form: FormData) {
  "use server";
  const actor = await adminActor();
  const table = String(form.get("table"));
  const keyColumn = String(form.get("key_column"));
  const keyKind = String(form.get("key_kind")) as LanceColumn["kind"];
  const key = typed(String(form.get("key")), keyKind);
  const back = href({ table, key_column: keyColumn, key: String(form.get("key")) });
  await flash(back, async () => {
    const values: Record<string, string | number | boolean | null> = {};
    for (const name of form.getAll("col").map(String)) {
      const kind = String(form.get(`kind:${name}`)) as LanceColumn["kind"];
      const before = form.get(`orig:${name}`);
      if (form.get(`null:${name}`) === "on") {
        if (before !== null) values[name] = null;
        continue;
      }
      const now = String(form.get(`val:${name}`) ?? "");
      if (before === null || now !== String(before)) values[name] = typed(now, kind);
    }
    if (!Object.keys(values).length) return "Nothing changed.";
    const r = await agent(() => lanceUpdate(table, { keyColumn, key, actor: actor.label }, values));
    await audit(actor, "lancedb.update", `${table}:${keyColumn}=${String(key).slice(0, 100)}`, { columns: Object.keys(values), version: r.version });
    return `Saved ${Object.keys(values).length} column(s). Table version ${r.version}.`;
  });
}

async function deleteRow(form: FormData) {
  "use server";
  const actor = await adminActor();
  const table = String(form.get("table"));
  const keyColumn = String(form.get("key_column"));
  const key = typed(String(form.get("key")), String(form.get("key_kind")) as LanceColumn["kind"]);
  if (form.get("confirm") !== "on") {
    await flash(href({ table, key_column: keyColumn, key: String(form.get("key")) }), async () => {
      throw new PostError("Tick the box to confirm the delete.");
    });
  }
  await flash(href({ table }), async () => {
    const r = await agent(() => lanceDelete(table, { keyColumn, key, actor: actor.label }));
    await audit(actor, "lancedb.delete", `${table}:${keyColumn}=${String(key).slice(0, 100)}`, { version: r.version }, { severity: "warning" });
    return `Deleted the row. Table version ${r.version}.`;
  });
}

function NotConfigured() {
  return (
    <Card>
      <h2 className="mb-2 text-lg font-semibold text-fg">LanceDB has no storage yet</h2>
      <p className="text-sm text-fg-muted">
        The SEO agent keeps LanceDB on Cloudflare R2, under <code>jithendar/seo-agent/lancedb/</code> in the media bucket, with the keys from{" "}
        <Link className={linkCls} href="/admin/storage">Storage</Link>. Set up storage there; the agent picks it up within a minute. For local
        development, <code>LANCEDB_URI</code> on the agent points it at a folder instead.
      </p>
    </Card>
  );
}

export default async function LanceDbPage({ searchParams }: { searchParams: Promise<Sp> }) {
  await requireRole("admin");
  const sp = await searchParams;
  let overview: Awaited<ReturnType<typeof lanceOverview>>;
  try {
    overview = await lanceOverview();
  } catch (e) {
    const msg = e instanceof AgentError ? e.message : "The SEO agent did not answer.";
    return (
      <>
        <AdminHeader title="LanceDB" description="The SEO agent's vector store." />
        <Flash error={msg} />
      </>
    );
  }
  const table = overview.tables.find((t) => t.name === sp.table) ?? null;
  const page = Math.max(1, Number(sp.page) || 1);
  const browse = table ? await lanceBrowse(table.name, (page - 1) * PAGE, PAGE) : null;
  const keyColumn = table ? (table.columns.find((c) => c.editable && c.name === sp.key_column)?.name ?? defaultKey(table.columns)) : null;
  const keyCol = table?.columns.find((c) => c.name === keyColumn) ?? null;
  let row: Awaited<ReturnType<typeof lanceRow>> | null = null;
  let rowError: string | null = null;
  if (table && keyCol && sp.key !== undefined) {
    try {
      row = await lanceRow(table.name, { keyColumn: keyCol.name, key: typed(sp.key, keyCol.kind) });
    } catch (e) {
      rowError = e instanceof AgentError ? e.message : "Could not read the row.";
    }
  }
  const pages = browse ? Math.max(1, Math.ceil(browse.total / PAGE)) : 1;

  return (
    <>
      <AdminHeader
        title="LanceDB"
        description="The SEO agent's vector store: CrewAI memory and the article index. Edits change one row at a time; vectors are read-only, and every change is a new table version and an audit log entry."
      />
      <Flash ok={sp.ok} error={sp.error ?? rowError ?? undefined} />

      {!overview.configured ? (
        <NotConfigured />
      ) : (
        <>
          <div className="mb-6 grid gap-4 sm:grid-cols-3">
            <Stat label="Tables" value={overview.tables.length} />
            <Stat label="Rows" value={overview.tables.reduce((n, t) => n + t.rows, 0).toLocaleString()} />
            <Stat label="Location" value={<span className="break-all font-mono text-sm">{overview.location}</span>} />
          </div>

          {row && table && keyCol && (
            <Card className="mb-6">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-lg font-semibold text-fg">
                  <code>{table.name}</code> <span className="text-sm font-normal text-fg-subtle">· {keyCol.name} = {sp.key}</span>
                </h2>
                <Link className={pill} href={href({ table: table.name, page: sp.page, key_column: keyCol.name })}>Close</Link>
              </div>
              <form action={saveRow} className="grid gap-4">
                <input type="hidden" name="table" value={table.name} />
                <input type="hidden" name="key_column" value={keyCol.name} />
                <input type="hidden" name="key_kind" value={keyCol.kind} />
                <input type="hidden" name="key" value={sp.key} />
                {row.columns.map((c) => {
                  const v = row.row[c.name];
                  const label = (
                    <span className="mb-1 block text-sm font-medium text-fg">
                      <code>{c.name}</code> <span className="text-xs font-normal text-fg-subtle">{c.type}</span>
                    </span>
                  );
                  if (!c.editable || (typeof v === "object" && v !== null)) {
                    return (
                      <div key={c.name}>
                        {label}
                        <p className="break-all rounded-lg bg-surface-2 p-2 font-mono text-xs text-fg-muted">{show(v)} <span className="text-fg-subtle">(read-only)</span></p>
                      </div>
                    );
                  }
                  const current = v === null ? "" : String(v);
                  return (
                    <div key={c.name}>
                      {label}
                      <input type="hidden" name="col" value={c.name} />
                      <input type="hidden" name={`kind:${c.name}`} value={c.kind} />
                      {v !== null && <input type="hidden" name={`orig:${c.name}`} value={current} />}
                      {c.kind === "bool" ? (
                        <Select name={`val:${c.name}`} defaultValue={current || "false"}>
                          <option value="true">true</option>
                          <option value="false">false</option>
                        </Select>
                      ) : c.kind === "string" && current.length > 80 ? (
                        <Textarea name={`val:${c.name}`} defaultValue={current} rows={Math.min(16, Math.ceil(current.length / 90))} />
                      ) : (
                        <Input name={`val:${c.name}`} defaultValue={current} inputMode={c.kind === "int" ? "numeric" : c.kind === "float" ? "decimal" : undefined} />
                      )}
                      {c.nullable && (
                        <label className="mt-1 flex items-center gap-2 text-xs text-fg-subtle">
                          <input type="checkbox" name={`null:${c.name}`} defaultChecked={v === null} /> empty (null)
                        </label>
                      )}
                    </div>
                  );
                })}
                <div>
                  <Button type="submit">Save changes</Button>
                </div>
              </form>
              <form action={deleteRow} className="mt-6 flex flex-wrap items-center gap-3 border-t border-line pt-4">
                <input type="hidden" name="table" value={table.name} />
                <input type="hidden" name="key_column" value={keyCol.name} />
                <input type="hidden" name="key_kind" value={keyCol.kind} />
                <input type="hidden" name="key" value={sp.key} />
                <label className="flex items-center gap-2 text-sm text-fg-muted">
                  <input type="checkbox" name="confirm" /> Delete this row
                </label>
                <Button type="submit" variant="danger" size="sm">Delete</Button>
              </form>
            </Card>
          )}

          {browse && table && (
            <Card className="mb-6">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-lg font-semibold text-fg">
                  <code>{browse.table}</code>{" "}
                  <span className="text-sm font-normal text-fg-subtle">· {browse.total.toLocaleString()} rows · version {browse.version} · page {page} of {pages}</span>
                </h2>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  {keyCol && (
                    <form className="flex items-center gap-2" action="/admin/lancedb">
                      <input type="hidden" name="table" value={table.name} />
                      <span className="text-fg-subtle">Key</span>
                      <Select name="key_column" defaultValue={keyCol.name}>
                        {table.columns.filter((c) => c.editable).map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                      </Select>
                      <Button type="submit" variant="secondary" size="sm">Use</Button>
                    </form>
                  )}
                  {page > 1 && <Link className={pill} href={href({ table: table.name, page: page - 1, key_column: keyColumn ?? undefined })}>← Previous</Link>}
                  {page < pages && <Link className={pill} href={href({ table: table.name, page: page + 1, key_column: keyColumn ?? undefined })}>Next →</Link>}
                  <Link className={pill} href="/admin/lancedb">Close</Link>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-line text-xs">
                  <thead>
                    <tr>
                      {keyCol && <th className="px-3 py-2" />}
                      {browse.columns.map((c) => <th key={c.name} className="whitespace-nowrap px-3 py-2 text-left font-semibold text-fg-subtle">{c.name}</th>)}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {browse.rows.map((r, i) => {
                      const k = keyCol ? r[keyCol.name] : null;
                      return (
                        <tr key={i}>
                          {keyCol && (
                            <td className="whitespace-nowrap px-3 py-2">
                              {k !== null && typeof k !== "object" ? <Link className={linkCls} href={href({ table: table.name, page, key_column: keyCol.name, key: String(k) })}>Open</Link> : <span className="text-fg-subtle">—</span>}
                            </td>
                          )}
                          {browse.columns.map((c) => <td key={c.name} className="max-w-xs truncate whitespace-nowrap px-3 py-2 font-mono text-fg-muted" title={show(r[c.name])}>{show(r[c.name])}</td>)}
                        </tr>
                      );
                    })}
                    {browse.rows.length === 0 && <tr><td className="px-3 py-6 text-fg-subtle" colSpan={browse.columns.length + 1}>No rows.</td></tr>}
                  </tbody>
                </table>
              </div>
              {!keyCol && <p className="mt-3 text-xs text-fg-subtle">This table has no scalar column to pick rows by, so it is read-only here.</p>}
            </Card>
          )}

          <Table head={<tr><th className={th}>Table</th><th className={th}>Rows</th><th className={th}>Version</th><th className={th}>Columns</th><th className={th} /></tr>}>
            {overview.tables.map((t) => (
              <tr key={t.name}>
                <td className={`${td} font-mono`}>{t.name}</td>
                <td className={td}>{t.rows.toLocaleString()}</td>
                <td className={td}>{t.version}</td>
                <td className={`${td} text-xs`}>{t.columns.map((c) => `${c.name} (${c.kind})`).join(", ")}</td>
                <td className={`${td} text-right`}><Link className={linkCls} href={href({ table: t.name })}>Browse</Link></td>
              </tr>
            ))}
            {overview.tables.length === 0 && <tr><td className={td} colSpan={5}>No tables yet. They appear here once the SEO agent writes to LanceDB.</td></tr>}
          </Table>
        </>
      )}
    </>
  );
}
