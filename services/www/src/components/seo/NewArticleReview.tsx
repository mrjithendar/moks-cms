"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Dialog } from "@/components/admin/Dialog";
import { Alert, Button } from "@/components/ui/form";
import type { Flag } from "@/lib/seo-intel/changeset";
import { Badge, StatusBadge } from "./badges";

export type NewArticleDoc = {
  title: string;
  slug_suggestion: string;
  meta_description: string;
  outline: string[];
  body_mdx: string;
  code_blocks?: { lang: string; code: string; purpose?: string }[];
  sources: { url: string; title?: string; used_for?: string }[];
  fact_check_flags: { claim: string; reason: string; severity: "error" | "warning" }[];
  internal_links: { target_path: string; anchor: string; reason: string }[];
  incomplete?: boolean;
  incomplete_reason?: string | null;
};

type Props = { draft: { id: string; status: string; flags: Flag[]; failureReason: string | null }; doc: NewArticleDoc | null; html: string; editorUrl: string };

async function post(url: string, body: unknown) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(j.error ?? `Request failed (${res.status}).`);
  return j;
}

/**
 * Review of a crew-written new article: the full document as the site will render it, with sources and fact-check
 * flags highlighted. Approve publishes the CMS draft post (after the graph verifies it); request changes sends feedback
 * to the crew; reject closes it. Nothing is published before the confirmation dialog.
 */
export function NewArticleReview({ draft, doc, html, editorUrl }: Props) {
  const router = useRouter();
  const [dialog, setDialog] = useState<null | "publish" | "reject" | "changes">(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flags = [...draft.flags];
  const blocking = flags.filter((f) => f.severity === "error");
  const open = draft.status === "ready_for_review";
  const act = async (url: string, body: unknown) => {
    setBusy(true);
    setError(null);
    try {
      await post(url, body);
      setDialog(null);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!doc) return <Alert tone="info">{draft.status === "generating" ? "The editorial crew is writing this article…" : draft.failureReason ?? "No document yet."}</Alert>;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={draft.status} />
        <Badge t="violet">New article · editorial crew</Badge>
        {doc.incomplete && <Badge t="red">Incomplete: {doc.incomplete_reason ?? "a limit was reached"}</Badge>}
        <Link href={editorUrl} className="ml-auto text-sm underline">Open the CMS draft</Link>
      </div>
      {error && <Alert tone="error">{error}</Alert>}

      <section aria-labelledby="na-meta" className="rounded-xl border border-line bg-surface p-4 sm:p-5">
        <h2 id="na-meta" className="text-sm font-semibold text-fg">Search result</h2>
        <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-[10rem_1fr]">
          <dt className="text-fg-subtle">Title ({doc.title.length}/60)</dt>
          <dd className={`font-medium ${doc.title.length > 60 ? "text-amber-800 dark:text-amber-200" : "text-fg"}`}>{doc.title}</dd>
          <dt className="text-fg-subtle">Meta ({doc.meta_description.length}, 120–155)</dt>
          <dd className={doc.meta_description.length < 120 || doc.meta_description.length > 155 ? "text-amber-800 dark:text-amber-200" : "text-fg"}>{doc.meta_description || "—"}</dd>
          <dt className="text-fg-subtle">Slug</dt>
          <dd className="font-mono text-fg">/blog/{doc.slug_suggestion}</dd>
          <dt className="text-fg-subtle">Outline</dt>
          <dd className="text-fg">{doc.outline.join(" · ") || "—"}</dd>
        </dl>
      </section>

      {(flags.length > 0 || doc.fact_check_flags.length > 0) && (
        <section aria-labelledby="na-flags" className="rounded-xl border border-amber-300 bg-amber-50/70 p-4 sm:p-5 dark:border-amber-500/40 dark:bg-amber-500/5">
          <h2 id="na-flags" className="text-sm font-semibold text-fg">Needs a human check ({flags.length})</h2>
          <ul className="mt-2 space-y-1.5 text-sm">
            {flags.map((f, i) => (
              <li key={i} className="flex gap-2">
                <Badge t={f.severity === "error" ? "red" : "amber"}>{f.severity === "error" ? "blocks approval" : f.code.replace(/_/g, " ")}</Badge>
                <span className="text-fg">{f.message}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="na-sources" className="rounded-xl border border-line bg-surface p-4 sm:p-5">
        <h2 id="na-sources" className="text-sm font-semibold text-fg">Sources ({doc.sources.length})</h2>
        {doc.sources.length ? (
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
            {doc.sources.map((s) => (
              <li key={s.url}>
                <a href={s.url} className="link [overflow-wrap:anywhere]" rel="noopener noreferrer" target="_blank">{s.title || s.url}</a>
                {s.used_for && <span className="text-fg-subtle"> — {s.used_for}</span>}
              </li>
            ))}
          </ol>
        ) : <p className="mt-2 text-sm text-amber-800 dark:text-amber-200">No sources: every technical claim needs checking.</p>}
        {doc.internal_links.length > 0 && (
          <>
            <h3 className="mt-4 text-sm font-semibold text-fg">Suggested internal links</h3>
            <ul className="mt-1 space-y-1 text-sm">{doc.internal_links.map((l) => <li key={l.target_path}>“{l.anchor}” → <Link className="underline" href={l.target_path}>{l.target_path}</Link> <span className="text-fg-subtle">({l.reason})</span></li>)}</ul>
          </>
        )}
      </section>

      <section aria-labelledby="na-body" className="rounded-xl border border-line bg-surface p-4 sm:p-6">
        <h2 id="na-body" className="mb-4 text-sm font-semibold text-fg">The article (new document)</h2>
        <h1 className="text-2xl font-bold text-fg">{doc.title}</h1>
        {/* Rendered on the server with the site's Markdown pipeline (raw HTML dropped, unsafe URLs removed). */}
        <div className="article-body prose mt-4 max-w-none dark:prose-invert" dangerouslySetInnerHTML={{ __html: html }} />
      </section>

      {open && (
        <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap justify-end gap-2 border-t border-line bg-canvas/95 px-4 py-3 backdrop-blur">
          <Button size="sm" variant="ghost" onClick={() => setDialog("reject")}>Reject</Button>
          <Button size="sm" variant="secondary" onClick={() => setDialog("changes")}>Request changes</Button>
          <Button size="sm" disabled={blocking.length > 0 || Boolean(doc.incomplete)} onClick={() => setDialog("publish")}>Approve &amp; publish</Button>
        </div>
      )}

      <Dialog open={dialog === "publish"} onClose={() => setDialog(null)} title="Approve and publish this new article" footer={<><Button variant="ghost" onClick={() => setDialog(null)}>Cancel</Button><Button disabled={busy} onClick={() => act(`/api/admin/seo/drafts/${draft.id}/approve`, {})}>Approve &amp; publish</Button></>}>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-fg-muted">
          <li>Your approval is recorded; the agent run resumes with it (it cannot publish without it).</li>
          <li>The CMS draft post gets this title, meta description and body and is published through the editor&apos;s normal update.</li>
          <li>The live page is checked (HTTP 200, self-canonical, indexable, title, JSON-LD); only then search engines are notified.</li>
        </ol>
      </Dialog>
      <Dialog open={dialog === "reject"} onClose={() => setDialog(null)} title="Reject this draft?" footer={<><Button variant="ghost" onClick={() => setDialog(null)}>Cancel</Button><Button variant="danger" disabled={busy} onClick={() => act(`/api/admin/seo/drafts/${draft.id}/reject`, { reason: text || null })}>Reject draft</Button></>}>
        <label className="text-sm text-fg-muted" htmlFor="na-reason">Reason (optional, used to improve future drafts)</label>
        <textarea id="na-reason" className="mt-1 w-full rounded-lg border border-line bg-canvas p-2 text-sm" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
      </Dialog>
      <Dialog open={dialog === "changes"} onClose={() => setDialog(null)} title="Ask the crew for changes" footer={<><Button variant="ghost" onClick={() => setDialog(null)}>Cancel</Button><Button disabled={busy || !text.trim()} onClick={() => act(`/api/admin/seo/drafts/${draft.id}/regenerate`, { feedback: text })}>Send</Button></>}>
        <label className="text-sm text-fg-muted" htmlFor="na-feedback">What should change?</label>
        <textarea id="na-feedback" className="mt-1 w-full rounded-lg border border-line bg-canvas p-2 text-sm" rows={4} value={text} onChange={(e) => setText(e.target.value)} />
      </Dialog>
    </div>
  );
}
