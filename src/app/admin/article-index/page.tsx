import Link from "next/link";
import { Flash } from "@/components/admin/Flash";
import { AdminHeader, Card, Stat, StatusPill, Table, td, th } from "@/components/admin/ui";
import { Button, Input } from "@/components/ui/form";
import {
  AgentError,
  chunkArticles,
  chunkOverview,
  chunkRow,
  chunkRows,
  type ChunkOverview,
  type ChunkTable,
  type ChunkTableInfo,
  type ChunkVector,
} from "@/lib/seo-agent/client";
import { requireRole } from "@/lib/session";

export const metadata = { title: "Article index" };
export const dynamic = "force-dynamic";

/**
 * The article index in pgvector (D-103): the chunks Ask the Blog and the agents search, read through the SEO agent
 * (lib/seo-agent/client.ts → seo-agent app/chunk_browser.py), which owns the tables. Read-only: a chunk edited by hand
 * would no longer match its vector, and the next reindex rewrites it anyway.
 */

const PAGE = 25;
const linkCls = "font-semibold text-accent-text hover:underline";
const pill = "rounded-lg border border-line-strong px-3 py-1.5 text-sm";
const REINDEX = "/admin/crewai/flows/reindex_flow";

type Sp = { table?: string; q?: string; page?: string; article?: string; text?: string; chunk?: string };

function href(p: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams(Object.entries(p).filter((e): e is [string, string | number] => e[1] !== undefined && e[1] !== "" && !(e[0] === "table" && e[1] === "live")).map(([k, v]) => [k, String(v)]));
  return `/admin/article-index${q.size ? `?${q}` : ""}`;
}

const when = (s: string | null | undefined) => (s ? `${new Date(s).toISOString().slice(0, 16).replace("T", " ")} UTC` : "—");
const size = (b: number | null) => (b === null ? "—" : b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MiB` : `${Math.ceil(b / 1024)} KiB`);
const vec = (v: ChunkVector) => `[${v.head.map((x) => x.toFixed(3)).join(", ")}${v.dims > v.head.length ? ", …" : ""}]`;

async function load<T>(fn: () => Promise<T>): Promise<{ data: T | null; error: string | null }> {
  try {
    return { data: await fn(), error: null };
  } catch (e) {
    return { data: null, error: e instanceof AgentError ? e.message : "The SEO agent did not answer." };
  }
}

function Pager({ total, offset, at }: { total: number; offset: number; at: (page: number) => string }) {
  const page = Math.floor(offset / PAGE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  if (pages === 1) return null;
  return (
    <div className="mt-3 flex items-center gap-2 text-sm text-fg-subtle">
      {page > 1 && <Link className={pill} href={at(page - 1)}>← Previous</Link>}
      <span>Page {page} of {pages}</span>
      {page < pages && <Link className={pill} href={at(page + 1)}>Next →</Link>}
    </div>
  );
}

/** What an admin must know before reading the rows: a rebuild in progress, or a table made by another model. */
function Notices({ ov, live, rebuild }: { ov: ChunkOverview; live: ChunkTableInfo | undefined; rebuild: ChunkTableInfo | undefined }) {
  const stale = live && ov.model && !rebuild && live.models.some((m) => m.model !== ov.model);
  return (
    <>
      {rebuild && (
        <Card className="mb-6 border-amber-500/40">
          <h2 className="mb-1 font-semibold text-fg">Rebuild in progress for {ov.model}</h2>
          <p className="text-sm text-fg-muted">
            {rebuild.rows.toLocaleString()} of about {(live?.rows ?? 0).toLocaleString()} chunks are embedded in the new table ({rebuild.vector}). Until a complete
            reindex swaps it in, Ask the Blog answers with its fallback and the agents find no related articles, because new question vectors no longer fit the
            live table ({live?.vector ?? "none"}). If no Reindex run is going, start one in <Link className={linkCls} href={REINDEX}>Flows → Reindex</Link>.
          </p>
        </Card>
      )}
      {stale && (
        <Card className="mb-6 border-amber-500/40">
          <h2 className="mb-1 font-semibold text-fg">Some chunks were made by another model</h2>
          <p className="text-sm text-fg-muted">
            The agent now embeds with {ov.model}, but the table also holds {live.models.filter((m) => m.model !== ov.model).map((m) => `${m.rows.toLocaleString()} from ${m.model}`).join(", ")}.
            Their vectors do not compare with new questions: run a full reindex in <Link className={linkCls} href={REINDEX}>Flows → Reindex</Link>.
          </p>
        </Card>
      )}
    </>
  );
}

async function ChunkView({ id, table, back }: { id: number; table: ChunkTable; back: string }) {
  const { data, error } = await load(() => chunkRow(id, table));
  if (!data) return <Flash error={error ?? "Could not read the chunk."} />;
  const c = data.chunk;
  const at = c.path ? `${c.path}${c.anchor ? `#${c.anchor}` : ""}` : null;
  return (
    <Card className="mb-6">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-fg">
            {c.title} <span className="text-sm font-normal text-fg-subtle">· chunk {c.chunk_index}{c.parts > 1 ? ` (part ${c.part + 1} of ${c.parts})` : ""}</span>
          </h2>
          <p className="text-sm text-fg-subtle">{c.heading_path || "(before the first heading)"}{at && <> · <a className={linkCls} href={at} target="_blank" rel="noreferrer">{at}</a></>}</p>
        </div>
        <Link className={pill} href={back}>Close</Link>
      </div>
      <pre className="mb-4 max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-sunken p-3 text-sm text-fg">{c.content}</pre>
      <dl className="mb-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <div><dt className="text-fg-subtle">Model</dt><dd className="font-mono text-fg-muted">{c.model}</dd></div>
        <div><dt className="text-fg-subtle">Updated</dt><dd className="text-fg-muted">{when(c.updated_at)}</dd></div>
        <div><dt className="text-fg-subtle">Vector</dt><dd className="font-mono text-xs text-fg-muted">{c.vector.dims} dims · norm {c.vector.norm} · {vec(c.vector)}</dd></div>
        <div><dt className="text-fg-subtle">Content hash</dt><dd className="break-all font-mono text-xs text-fg-muted">{c.content_hash}</dd></div>
        <div className="sm:col-span-2"><dt className="text-fg-subtle">Identifiers (exact-match search terms)</dt><dd className="font-mono text-xs text-fg-muted">{c.identifiers.length ? c.identifiers.join(", ") : "none"}</dd></div>
      </dl>
      {c.embed_text && (
        <details className="mb-4">
          <summary className="cursor-pointer text-sm font-medium text-fg">Text that was embedded (title and heading path in front)</summary>
          <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-sunken p-3 text-xs text-fg-muted">{c.embed_text}</pre>
        </details>
      )}
      <h3 className="mb-2 text-sm font-semibold text-fg">Nearest chunks (cosine similarity)</h3>
      <Table head={<tr><th className={th}>Score</th><th className={th}>Article</th><th className={th}>Section</th><th className={th} /></tr>}>
        {data.similar.map((s) => (
          <tr key={s.id}>
            <td className={`${td} font-mono`}>{s.score.toFixed(3)}</td>
            <td className={td}>{s.title}</td>
            <td className={td}>{s.heading_path || "—"} <span className="text-fg-subtle">· chunk {s.chunk_index}</span></td>
            <td className={`${td} text-right`}><Link className={linkCls} href={href({ table, chunk: s.id })}>Open</Link></td>
          </tr>
        ))}
        {data.similar.length === 0 && <tr><td className={td} colSpan={4}>No other chunks.</td></tr>}
      </Table>
    </Card>
  );
}

async function ChunkList({ table, article, text, offset }: { table: ChunkTable; article?: string; text?: string; offset: number }) {
  const { data, error } = await load(() => chunkRows({ table, articleId: article, q: text, offset, limit: PAGE }));
  if (!data) return <Flash error={error ?? "Could not read the chunks."} />;
  const title = article ? (data.items[0]?.title ?? "This article") : `Chunks containing “${text}”`;
  return (
    <Card className="mb-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-fg">{title} <span className="text-sm font-normal text-fg-subtle">· {data.total.toLocaleString()} chunks</span></h2>
        <Link className={pill} href={href({ table })}>All articles</Link>
      </div>
      <Table head={<tr><th className={th}>#</th>{!article && <th className={th}>Article</th>}<th className={th}>Section</th><th className={th}>Text</th><th className={th}>Vector</th><th className={th}>Updated</th><th className={th} /></tr>}>
        {data.items.map((r) => (
          <tr key={r.id}>
            <td className={`${td} font-mono`}>{r.chunk_index}{r.parts > 1 ? `.${r.part}` : ""}</td>
            {!article && <td className={td}>{r.title}</td>}
            <td className={`${td} min-w-40`}>{r.heading_path || "—"}</td>
            <td className={`${td} min-w-80 max-w-xl text-xs`}>{r.content}{r.length > r.content.length ? "…" : ""} <span className="text-fg-subtle">({r.length.toLocaleString()} chars)</span></td>
            <td className={`${td} whitespace-nowrap font-mono text-xs`} title={vec(r.vector)}>{r.vector.dims} · {r.vector.norm}</td>
            <td className={`${td} whitespace-nowrap text-xs`}>{when(r.updated_at)}</td>
            <td className={`${td} text-right`}><Link className={linkCls} href={href({ table, article, text, chunk: r.id, page: Math.floor(offset / PAGE) + 1 })}>Open</Link></td>
          </tr>
        ))}
        {data.items.length === 0 && <tr><td className={td} colSpan={7}>No chunks.</td></tr>}
      </Table>
      <Pager total={data.total} offset={offset} at={(p) => href({ table, article, text, page: p })} />
    </Card>
  );
}

async function ArticleList({ table, q, offset }: { table: ChunkTable; q?: string; offset: number }) {
  const { data, error } = await load(() => chunkArticles({ table, q, offset, limit: PAGE }));
  if (!data) return <Flash error={error ?? "Could not read the articles."} />;
  return (
    <>
      <Table head={<tr><th className={th}>Article</th><th className={th}>Status</th><th className={th}>Chunks</th><th className={th}>Model</th><th className={th}>Updated</th><th className={th} /></tr>}>
        {data.items.map((a) => (
          <tr key={a.article_id}>
            <td className={td}>
              <p className="font-medium text-fg">{a.title}</p>
              {a.path && <p className="font-mono text-xs text-fg-subtle">{a.path}</p>}
            </td>
            <td className={td}><StatusPill status={a.status} /></td>
            <td className={`${td} tabular-nums`}>{a.chunks.toLocaleString()}</td>
            <td className={`${td} font-mono text-xs`}>{a.models.join(", ")}</td>
            <td className={`${td} whitespace-nowrap text-xs`}>{when(a.updated_at)}</td>
            <td className={`${td} text-right`}><Link className={linkCls} href={href({ table, article: a.article_id })}>Chunks</Link></td>
          </tr>
        ))}
        {data.items.length === 0 && <tr><td className={td} colSpan={6}>{q ? "No article matches." : "No chunks yet. Publishing an article or running the Reindex flow fills the index."}</td></tr>}
      </Table>
      <p className="mt-2 text-xs text-fg-subtle">{data.total.toLocaleString()} articles. A draft, deleted or missing article&apos;s chunks stay until the next full reindex.</p>
      <Pager total={data.total} offset={offset} at={(p) => href({ table, q, page: p })} />
    </>
  );
}

export default async function ArticleIndexPage({ searchParams }: { searchParams: Promise<Sp> }) {
  await requireRole("admin");
  const sp = await searchParams;
  const header = (
    <AdminHeader
      title="Article index"
      description="The pgvector index Ask the Blog and the agents search: every published article's chunks and their vectors. Read-only; publishing an article or running the Reindex flow changes it."
    />
  );
  const { data: ov, error } = await load(() => chunkOverview());
  if (!ov) return <>{header}<Flash error={error ?? "The SEO agent did not answer."} /></>;
  if (!ov.available) {
    return (
      <>
        {header}
        <Card>
          <h2 className="mb-2 text-lg font-semibold text-fg">The article index is not available</h2>
          <p className="text-sm text-fg-muted">The SEO agent says: {ov.reason}. It needs the pgvector extension in its database (docs/seo/MANUAL_SETUP.md).</p>
        </Card>
      </>
    );
  }
  const live = ov.tables.find((t) => t.table === "live");
  const rebuild = ov.tables.find((t) => t.table === "rebuild");
  const table: ChunkTable = sp.table === "rebuild" && rebuild ? "rebuild" : "live";
  const shown = table === "rebuild" ? rebuild : live;
  const offset = (Math.max(1, Number(sp.page) || 1) - 1) * PAGE;
  const chunkId = sp.chunk && /^\d+$/.test(sp.chunk) ? Number(sp.chunk) : null;
  const text = sp.text?.trim() || undefined;

  return (
    <>
      {header}
      <Notices ov={ov} live={live} rebuild={rebuild} />
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Chunks" value={(shown?.rows ?? 0).toLocaleString()} hint={`${(shown?.articles ?? 0).toLocaleString()} articles`} />
        <Stat label="Embeddings model" value={<span className="break-all font-mono text-base">{ov.model ?? "—"}</span>} hint={ov.dimensions ? `${ov.dimensions} dimensions` : undefined} />
        <Stat label="Vector column" value={<span className="font-mono text-base">{shown?.vector ?? "—"}</span>} hint={`${shown?.index ?? "no"} index · pgvector ${ov.pgvector ?? "?"}`} />
        <Stat label="Size" value={size(shown?.bytes ?? null)} hint={`Updated ${when(shown?.updated_at)}`} />
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-3">
        {rebuild && (
          <div className="flex gap-2 text-sm">
            <Link className={`${pill} ${table === "live" ? "bg-surface-muted font-semibold" : ""}`} href={href({ table: "live" })}>Live table</Link>
            <Link className={`${pill} ${table === "rebuild" ? "bg-surface-muted font-semibold" : ""}`} href={href({ table: "rebuild" })}>Rebuild table</Link>
          </div>
        )}
        <form className="flex items-center gap-2" action="/admin/article-index">
          {table === "rebuild" && <input type="hidden" name="table" value="rebuild" />}
          <Input name="q" defaultValue={sp.q ?? ""} placeholder="Article title or slug" aria-label="Filter articles" />
          <Button type="submit" variant="secondary" size="sm">Filter</Button>
        </form>
        <form className="flex items-center gap-2" action="/admin/article-index">
          {table === "rebuild" && <input type="hidden" name="table" value="rebuild" />}
          <Input name="text" defaultValue={text ?? ""} placeholder="Text in a chunk" aria-label="Search chunk text" />
          <Button type="submit" variant="secondary" size="sm">Search chunks</Button>
        </form>
      </div>

      {chunkId !== null && <ChunkView id={chunkId} table={table} back={href({ table, article: sp.article, text, page: sp.page })} />}
      {sp.article || text ? <ChunkList table={table} article={sp.article} text={text} offset={offset} /> : <ArticleList table={table} q={sp.q?.trim() || undefined} offset={offset} />}

      {shown && shown.models.length > 0 && (
        <p className="mt-6 text-xs text-fg-subtle">
          Table <code>{shown.name}</code>: {shown.models.map((m) => `${m.rows.toLocaleString()} chunks from ${m.model}`).join(", ")}.
        </p>
      )}
    </>
  );
}
