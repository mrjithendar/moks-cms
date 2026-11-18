"use client";

import { LocalTime } from "@/components/LocalTime";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Dialog } from "@/components/admin/Dialog";
import { Alert, Button, buttonClass } from "@/components/ui/form";
import type { BaseSnapshot, Change, Flag } from "@/lib/seo-intel/changeset";
import { changeDiff, serpPreview, summarize, type Seg } from "@/lib/seo-intel/diff-model";
import { Badge, StatusBadge } from "./badges";

export type SubmissionRow = { engine: string; status: string; requestedAt: string; responseCode: number | null; error: string | null; inspection: { coverageState?: string; verdict?: string; lastCrawlTime?: string } | null; kind: string };
export type ReviewProps = {
  draft: { id: string; status: string; changes: Change[]; flags: Flag[]; summary: string | null; failureReason: string | null; verification: { state: string; attempts: number; checks?: { key: string; ok: boolean; detail: string }[] } | null; scheduledFor: string | null; decidedBy: string | null; decidedAt: string | null; substantive: boolean | null; categories: string[] };
  article: { id: string; title: string; path: string; collection: string; liveUrl: string };
  base: BaseSnapshot;
  evidence: Record<string, { label: string; detail: string }>;
  submissions: SubmissionRow[];
};

const TYPE_LABEL: Record<string, string> = { title: "Search title", meta_description: "Meta description", heading: "Heading", paragraph_edit: "Edit", paragraph_add: "Addition", code_block: "Code block", internal_link: "Internal link", external_link: "Docs link (nofollow)", link_fix: "Broken link fix", alt_text: "Alt text", schema: "Structured data" };

async function call(url: string, method: string, body?: unknown) {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).catch(() => null);
  const data = (await res?.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: Boolean(res?.ok), status: res?.status ?? 0, data };
}

function Segments({ segs, side }: { segs: Seg[]; side: "both" | "before" | "after" }) {
  return (
    <>
      {segs.map((s, i) => {
        const sp = i ? " " : "";
        if (s.op === "del") return side === "after" ? null : <span key={i}>{sp}<del className="rounded-sm bg-red-100 px-0.5 text-red-900 decoration-red-700/70 dark:bg-red-500/20 dark:text-red-100"><span className="sr-only">[removed: </span>{s.text}<span className="sr-only">]</span></del></span>;
        if (s.op === "ins") return side === "before" ? null : <span key={i}>{sp}<ins className="rounded-sm bg-emerald-100 px-0.5 text-emerald-950 no-underline dark:bg-emerald-500/20 dark:text-emerald-50"><span className="sr-only">[added: </span>{s.text}<span className="sr-only">]</span></ins></span>;
        if (s.linkChange && side !== "before")
          return <span key={i}>{sp}<span className={`rounded-sm px-0.5 underline decoration-2 underline-offset-2 ${s.linkChange === "added" ? "bg-sky-100 decoration-sky-600 dark:bg-sky-500/20" : "bg-red-100 decoration-red-600 dark:bg-red-500/20"}`}>{s.text}</span><span className="ml-1 rounded bg-surface-sunken px-1 font-mono text-[0.7rem] text-fg-subtle">{s.linkChange === "added" ? `→ ${s.href}` : "link removed"}</span></span>;
        return <span key={i}>{sp}{s.href ? <span className="underline decoration-dotted underline-offset-2">{s.text}</span> : s.text}</span>;
      })}
    </>
  );
}

function DiffBody({ c, mode }: { c: Change; mode: "auto" | "inline" | "split" }) {
  const d = changeDiff(c);
  if (d.kind === "code") {
    return (
      <pre className="overflow-x-auto rounded-lg border border-line bg-surface-muted p-3 text-xs leading-5">
        {d.lines!.map((l, i) => (
          <div key={i} className={l.op === "ins" ? "bg-emerald-100 dark:bg-emerald-500/15" : l.op === "del" ? "bg-red-100 line-through decoration-red-700/50 dark:bg-red-500/15" : ""}>
            <span aria-hidden="true" className="mr-2 select-none text-fg-subtle">{l.op === "ins" ? "+" : l.op === "del" ? "−" : " "}</span>
            {l.op === "ins" && <span className="sr-only">added line: </span>}
            {l.op === "del" && <span className="sr-only">removed line: </span>}
            {l.text || " "}
          </div>
        ))}
      </pre>
    );
  }
  const box = "rounded-lg border border-line bg-surface p-3 text-[0.95rem] leading-7 text-fg [overflow-wrap:anywhere]";
  if (mode === "auto") {
    // Default: inline on phones and tablets, side by side on wide screens (pure CSS, no layout shift).
    return (
      <>
        <div className="lg:hidden"><DiffBody c={c} mode="inline" /></div>
        <div className="hidden lg:block"><DiffBody c={c} mode="split" /></div>
      </>
    );
  }
  if (mode === "split") {
    return (
      <div className="grid gap-2 md:grid-cols-2">
        <div><p className="mb-1 text-xs font-medium text-fg-subtle">Before</p><div className={box}>{c.before ? <Segments segs={d.segments} side="before" /> : <span className="text-fg-subtle">(new block)</span>}</div></div>
        <div><p className="mb-1 text-xs font-medium text-fg-subtle">After</p><div className={box}><Segments segs={d.segments} side="after" /></div></div>
      </div>
    );
  }
  return <div className={box}><Segments segs={d.segments} side="both" /></div>;
}

function Serp({ title, description, url, label }: { title: string; description: string; url: string; label: string }) {
  const p = serpPreview(title, description);
  const host = url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {(["desktop", "mobile"] as const).map((dev) => (
        <figure key={dev} className={`rounded-lg border border-line bg-white p-3 text-left dark:bg-[#202124] ${dev === "mobile" ? "max-w-[360px]" : ""}`}>
          <figcaption className="mb-2 text-[0.7rem] uppercase tracking-wide text-fg-subtle">{label} · {dev} (approximate)</figcaption>
          <p className="truncate text-xs text-[#4d5156] dark:text-[#bdc1c6]">{host}</p>
          <p className={`mt-0.5 text-[#1a0dab] dark:text-[#8ab4f8] ${dev === "desktop" ? "text-xl leading-snug" : "text-lg leading-snug"}`}>{p[dev].title.text}</p>
          <p className="mt-1 text-sm leading-snug text-[#4d5156] dark:text-[#bdc1c6]">{p[dev].description.text}</p>
          {(p[dev].title.truncated || p[dev].description.truncated) && <p className="mt-1 text-[0.7rem] text-amber-800 dark:text-amber-300">Likely truncated on {dev}.</p>}
        </figure>
      ))}
    </div>
  );
}

function FlagList({ flags }: { flags: Flag[] }) {
  if (!flags.length) return null;
  return (
    <ul className="mt-2 space-y-1">
      {flags.map((f, i) => (
        <li key={i} className={`flex items-start gap-2 text-sm ${f.severity === "error" ? "text-red-800 dark:text-red-200" : "text-amber-900 dark:text-amber-200"}`}>
          <Badge t={f.severity === "error" ? "red" : "amber"}>{f.code === "needs_fact_check" ? "Needs fact check" : f.severity === "error" ? "Blocks approval" : "Check"}</Badge>
          <span>{f.message}</span>
        </li>
      ))}
    </ul>
  );
}

export function DiffReview({ draft: initial, article, base, evidence, submissions }: ReviewProps) {
  const router = useRouter();
  const [changes, setChanges] = useState<Change[]>(initial.changes);
  const [mode, setMode] = useState<"auto" | "inline" | "split">("auto");
  const [active, setActive] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | "publish" | "later" | "reject" | "rollback">(null);
  const [when, setWhen] = useState("");
  const [reason, setReason] = useState("");
  const refs = useRef<(HTMLElement | null)[]>([]);
  const status = initial.status;
  const reviewing = status === "ready_for_review";

  useEffect(() => {
    if (status !== "generating" && !(status === "published" && initial.verification?.state !== "passed" && initial.verification?.state !== "failed")) return;
    const t = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(t);
  }, [status, initial.verification?.state, router]);

  const go = useCallback((i: number) => {
    const n = Math.max(0, Math.min(changes.length - 1, i));
    setActive(n);
    refs.current[n]?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    refs.current[n]?.focus({ preventScroll: true });
  }, [changes.length]);

  const decide = useCallback(async (c: Change, decision: "accepted" | "rejected" | "pending", edited?: string | null) => {
    setBusy(c.id);
    setError(null);
    const r = await call(`/api/admin/seo/drafts/${initial.id}/changes/${c.id}`, "PATCH", { decision, ...(edited !== undefined ? { edited } : {}) });
    setBusy(null);
    if (!r.ok) return setError(String(r.data.error ?? "Could not save the decision."));
    const updated = r.data.change as Change;
    setChanges((cs) => cs.map((x) => (x.id === c.id ? updated : x)));
    setEditing(null);
  }, [initial.id]);

  // j / k (and ← →) move between changes; a = accept, x = reject. Ignored while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable=true]") || e.metaKey || e.ctrlKey || e.altKey || dialog) return;
      if (e.key === "j") go(active + 1);
      else if (e.key === "k") go(active - 1);
      else if (reviewing && e.key === "a" && changes[active]) void decide(changes[active]!, "accepted");
      else if (reviewing && e.key === "x" && changes[active]) void decide(changes[active]!, "rejected");
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, changes, go, decide, reviewing, dialog]);

  // Swipe left/right on a change card (phones) → next/previous change.
  const touch = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => (touch.current = { x: e.touches[0]!.clientX, y: e.touches[0]!.clientY });
  const onTouchEnd = (e: React.TouchEvent) => {
    const s = touch.current;
    touch.current = null;
    if (!s) return;
    const dx = e.changedTouches[0]!.clientX - s.x;
    const dy = e.changedTouches[0]!.clientY - s.y;
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.8) go(active + (dx < 0 ? 1 : -1));
  };

  const sum = useMemo(() => summarize(base, changes.filter((c) => c.decision !== "rejected")), [base, changes]);
  const accepted = changes.filter((c) => c.decision === "accepted").length;
  const pending = changes.filter((c) => c.decision === "pending").length;
  const blocking = changes.filter((c) => c.decision === "accepted" && c.flags.some((f) => f.severity === "error"));
  const titleChange = changes.find((c) => c.type === "title" && c.decision !== "rejected");
  const metaChange = changes.find((c) => c.type === "meta_description" && c.decision !== "rejected");
  const curTitle = (base.seoTitle || base.title).trim();
  const curMeta = (base.seoDescription || base.description).trim();

  async function act(kind: "publish" | "later" | "reject" | "rollback") {
    setBusy(kind);
    setError(null);
    const r = kind === "reject"
      ? await call(`/api/admin/seo/drafts/${initial.id}/reject`, "POST", { reason: reason || null })
      : kind === "rollback"
        ? await call(`/api/admin/seo/drafts/${initial.id}/rollback`, "POST")
        : await call(`/api/admin/seo/drafts/${initial.id}/approve`, "POST", kind === "later" ? { publishAt: new Date(when).toISOString() } : {});
    setBusy(null);
    setDialog(null);
    if (!r.ok) return setError(String(r.data.error ?? "That did not work."));
    router.refresh();
  }

  const header: ReactNode = (
    <div className="mb-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={status} />
        {initial.categories.map((c) => <Badge key={c}>{c.replace(/_/g, " ")}</Badge>)}
        {article.collection === "news" && <Badge t="blue">News</Badge>}
      </div>
      <h1 className="mt-2 text-xl font-semibold text-fg sm:text-2xl [overflow-wrap:anywhere]">{article.title}</h1>
      <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <a className="underline" href={article.liveUrl} target="_blank" rel="noopener">Live page ↗</a>
        <a className="underline" href={`/preview/seo-draft/${initial.id}`} target="_blank" rel="noopener">Preview final page ↗</a>
        <Link className="underline" href={`/admin/posts/${article.id}/insights`}>Article SEO panel</Link>
      </p>
      {initial.summary && <p className="mt-2 text-sm text-fg-muted">{initial.summary}</p>}
    </div>
  );

  if (status === "generating" || (status === "generation_failed" && !changes.length)) {
    return (
      <div>
        {header}
        {status === "generating" ? <Alert tone="info">Claude is drafting this article&apos;s changes. This page refreshes on its own.</Alert> : <Alert>{initial.failureReason ?? "Generation failed."}</Alert>}
        {status === "generation_failed" && <Button className="mt-4" loading={busy === "regen"} onClick={async () => { setBusy("regen"); const r = await call(`/api/admin/seo/drafts/${initial.id}/regenerate`, "POST"); setBusy(null); if (!r.ok) setError(String(r.data.error)); else router.refresh(); }}>Try again</Button>}
        {error && <div className="mt-3"><Alert>{error}</Alert></div>}
      </div>
    );
  }

  return (
    <div className="pb-28">
      {header}

      {/* Summary bar */}
      <div className="sticky top-0 z-20 -mx-4 mb-4 border-y border-line bg-surface/95 px-4 py-2 backdrop-blur sm:mx-0 sm:rounded-xl sm:border">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <span className="font-semibold text-fg tabular-nums">{changes.length} change{changes.length === 1 ? "" : "s"}</span>
          <span className="text-fg-muted">{sum.breakdownLabel}</span>
          <span className="tabular-nums"><span className="text-emerald-800 dark:text-emerald-300">+{sum.plusWords}</span> / <span className="text-red-800 dark:text-red-300">−{sum.minusWords}</span> words</span>
          {sum.linksAdded > 0 && <span className="tabular-nums text-fg-muted">{sum.linksAdded} link{sum.linksAdded === 1 ? "" : "s"} added</span>}
          {sum.metadataChanged > 0 && <span className="text-fg-muted">{sum.metadataChanged} metadata field{sum.metadataChanged === 1 ? "" : "s"}</span>}
          <span className="ml-auto font-medium tabular-nums text-fg" aria-live="polite">{accepted} of {changes.length} accepted{pending ? ` · ${pending} undecided` : ""}</span>
          <div role="group" aria-label="Diff layout" className="flex overflow-hidden rounded-md border border-line-strong text-xs">
            {(["auto", "inline", "split"] as const).map((m) => <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)} className={`min-h-8 px-2.5 ${mode === m ? "bg-accent-soft font-semibold text-accent-text" : "text-fg-muted"} ${m === "split" ? "max-sm:hidden" : ""}`}>{m === "auto" ? "Auto" : m === "inline" ? "Inline" : "Side by side"}</button>)}
          </div>
        </div>
        {initial.substantive === false && status === "published" && <p className="mt-1 text-xs text-fg-subtle">Metadata-only update: the sitemap&apos;s lastmod and the visible “Updated” date were left unchanged.</p>}
      </div>

      {error && <div className="mb-4"><Alert>{error}</Alert></div>}
      {initial.flags.length > 0 && <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-3 dark:border-amber-500/30 dark:bg-amber-500/10"><FlagList flags={initial.flags} /></div>}
      {initial.failureReason && status === "ready_for_review" && <div className="mb-4"><Alert tone="info">{initial.failureReason}</Alert></div>}

      {(titleChange || metaChange) && (
        <section aria-labelledby="serp-h" className="mb-6">
          <h2 id="serp-h" className="mb-2 text-sm font-semibold text-fg">Search result preview</h2>
          <div className="grid gap-3">
            <Serp label="Now" title={curTitle} description={curMeta} url={article.liveUrl} />
            <Serp label="With accepted + undecided changes" title={(titleChange?.edited ?? titleChange?.after ?? curTitle).trim()} description={(metaChange?.edited ?? metaChange?.after ?? curMeta).trim()} url={article.liveUrl} />
          </div>
        </section>
      )}

      <ol className="space-y-4">
        {changes.map((c, i) => {
          const refsFor = c.evidenceRef.map((r) => evidence[r]).filter(Boolean);
          const decided = c.decision !== "pending";
          return (
            <li key={c.id}>
              <article
                ref={(el) => void (refs.current[i] = el)}
                tabIndex={-1}
                aria-labelledby={`${c.id}-h`}
                onFocus={() => setActive(i)}
                onTouchStart={onTouchStart}
                onTouchEnd={onTouchEnd}
                className={`scroll-mt-24 rounded-xl border bg-surface p-4 outline-none ${i === active ? "border-accent ring-2 ring-accent/30" : "border-line"} ${c.decision === "rejected" ? "opacity-60" : ""}`}
              >
                <header className="flex flex-wrap items-center gap-2">
                  <h3 id={`${c.id}-h`} className="text-sm font-semibold text-fg"><span className="tabular-nums text-fg-subtle">{i + 1}/{changes.length}</span> · {TYPE_LABEL[c.type] ?? c.type}</h3>
                  {c.location.headingPath && <span className="truncate text-xs text-fg-subtle">in “{c.location.headingPath}”</span>}
                  {c.decision === "accepted" && <Badge t="green">✓ {c.edited ? "Accepted with your edit" : "Accepted"}</Badge>}
                  {c.decision === "rejected" && <Badge>✕ Rejected</Badge>}
                  {c.origin === "rules" && <Badge t="blue">Rule-based</Badge>}
                </header>
                <div className="mt-3">
                  {editing === c.id ? (
                    <div>
                      <label htmlFor={`${c.id}-edit`} className="text-xs font-medium text-fg-subtle">Your version (accepting saves it)</label>
                      <textarea id={`${c.id}-edit`} value={editText} onChange={(e) => setEditText(e.target.value)} rows={Math.min(14, Math.max(3, editText.split("\n").length + 1))} className="mt-1 w-full rounded-lg border border-line-strong bg-surface p-2 font-mono text-sm" />
                      {(c.type === "title" || c.type === "meta_description") && <p className="mt-1 text-xs text-fg-subtle tabular-nums">{editText.trim().length} characters (aim for ≤ {c.type === "title" ? 60 : 155})</p>}
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Button size="sm" loading={busy === c.id} onClick={() => decide(c, "accepted", editText)}>Save &amp; accept</Button>
                        <Button size="sm" variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
                      </div>
                    </div>
                  ) : (
                    <DiffBody c={c} mode={mode} />
                  )}
                </div>
                <FlagList flags={c.flags} />
                <details className="group mt-3 rounded-lg bg-surface-muted px-3 py-2 text-sm">
                  <summary className="cursor-pointer list-none font-medium text-fg-muted [&::-webkit-details-marker]:hidden"><span aria-hidden="true" className="mr-1 inline-block transition-transform group-open:rotate-90">›</span>Why this change{refsFor.length ? ` · ${refsFor.length} evidence` : ""}</summary>
                  <p className="mt-2 text-fg">{c.rationale}</p>
                  {refsFor.length > 0 && <ul className="mt-2 space-y-1 text-fg-muted">{refsFor.map((e, k) => <li key={k}><strong className="font-medium text-fg">{e!.label}</strong>{e!.detail ? ` — ${e!.detail}` : ""}</li>)}</ul>}
                  {c.sourceUrls.length > 0 && <ul className="mt-2 space-y-1">{c.sourceUrls.map((u) => <li key={u}><a className="underline [overflow-wrap:anywhere]" href={u} target="_blank" rel="noopener noreferrer">{u}</a></li>)}</ul>}
                </details>
                {reviewing && editing !== c.id && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button size="sm" variant={c.decision === "accepted" ? "primary" : "secondary"} aria-pressed={c.decision === "accepted"} loading={busy === c.id} onClick={() => decide(c, c.decision === "accepted" ? "pending" : "accepted")}>{c.decision === "accepted" ? "✓ Accepted" : "Accept"}</Button>
                    <Button size="sm" variant={c.decision === "rejected" ? "danger" : "secondary"} aria-pressed={c.decision === "rejected"} onClick={() => decide(c, c.decision === "rejected" ? "pending" : "rejected")}>{c.decision === "rejected" ? "✕ Rejected" : "Reject"}</Button>
                    {c.type !== "internal_link" && c.type !== "external_link" && c.type !== "link_fix" && <Button size="sm" variant="ghost" onClick={() => { setEditing(c.id); setEditText(c.edited ?? c.after); }}>Edit</Button>}
                    {decided && <span className="sr-only">Decided</span>}
                  </div>
                )}
              </article>
            </li>
          );
        })}
      </ol>

      {status === "published" || status === "rolled_back" ? (
        <PublishedPanel initial={initial} submissions={submissions} onRollback={() => setDialog("rollback")} />
      ) : null}

      {/* Bottom action bar: thumb reach on phones */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 px-4 py-3 backdrop-blur pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-2">
          <div className="flex gap-1" role="group" aria-label="Navigate changes">
            <Button size="sm" variant="secondary" onClick={() => go(active - 1)} disabled={active === 0} aria-label="Previous change (k)">↑</Button>
            <Button size="sm" variant="secondary" onClick={() => go(active + 1)} disabled={active >= changes.length - 1} aria-label="Next change (j)">↓</Button>
          </div>
          <span className="hidden text-xs text-fg-subtle sm:inline">j / k to move · a accept · x reject</span>
          {reviewing && (
            <div className="ml-auto flex flex-wrap gap-2">
              <Button size="sm" variant="ghost" onClick={() => setDialog("reject")}>Reject draft</Button>
              <Button size="sm" variant="secondary" disabled={!accepted || blocking.length > 0} onClick={() => setDialog("later")}>Publish later</Button>
              <Button size="sm" disabled={!accepted || blocking.length > 0} onClick={() => setDialog("publish")}>Approve &amp; publish ({accepted})</Button>
            </div>
          )}
          {status === "scheduled" && <p className="ml-auto text-sm text-fg">Scheduled for <LocalTime iso={initial.scheduledFor} /> <Button size="sm" variant="ghost" onClick={() => setDialog("reject")}>Cancel &amp; reject</Button></p>}
        </div>
      </div>

      <Dialog open={dialog === "publish" || dialog === "later"} onClose={() => setDialog(null)} size="md" title={dialog === "later" ? "Approve and publish later" : "Approve and publish now"} footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setDialog(null)}>Cancel</Button><Button data-autofocus loading={busy === dialog} disabled={dialog === "later" && !when} onClick={() => act(dialog as "publish" | "later")}>{dialog === "later" ? "Schedule" : "Publish now"}</Button></div>}>
        <p className="text-sm text-fg">What happens {dialog === "later" ? "at the time you choose" : "now"}:</p>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-fg-muted">
          <li>{accepted} accepted change{accepted === 1 ? "" : "s"} {accepted === 1 ? "is" : "are"} saved to <strong className="text-fg">{article.path}</strong> as a new revision, through the editor&apos;s normal update (your permissions apply). {changes.length - accepted} rejected or undecided change{changes.length - accepted === 1 ? " is" : "s are"} left out.</li>
          <li>{sum && changes.some((c) => c.decision === "accepted" && ["heading", "paragraph_edit", "paragraph_add", "code_block"].includes(c.type)) ? "Body text changes: the “Updated” date and the sitemap’s lastmod move to now." : "Only metadata/links/alt text: the “Updated” date and sitemap lastmod stay as they are."}</li>
          <li>The page, sitemap and listings are refreshed.</li>
          <li>The live page is checked (HTTP 200, self-canonical, not noindex, expected title, valid JSON-LD). If a check fails, nothing is submitted and you get a one-click rollback.</li>
          <li>Then it is submitted: IndexNow (Bing, Yandex, Seznam, Naver…) and a Search Console sitemap resubmission; a URL Inspection check runs ~2–3 days later.</li>
          <li>Before/after metrics are recorded at 28 and 56 days.</li>
        </ol>
        <p className="mt-3 rounded-lg bg-surface-muted p-2 text-xs text-fg-muted">Submitting a URL is a crawl hint. It does not guarantee indexing or any ranking change.</p>
        {dialog === "later" && (
          <label className="mt-3 grid gap-1 text-sm text-fg">Publish at (your local time)
            <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="min-h-11 rounded-md border border-line-strong bg-surface px-2" />
          </label>
        )}
      </Dialog>
      <Dialog open={dialog === "reject"} onClose={() => setDialog(null)} size="md" title="Reject this draft?" footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setDialog(null)}>Cancel</Button><Button variant="danger" loading={busy === "reject"} onClick={() => act("reject")}>Reject draft</Button></div>}>
        <p className="text-sm text-fg-muted">Nothing is published. The reason is stored and helps future drafts.</p>
        <textarea aria-label="Reason (optional)" placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={2000} className="mt-3 w-full rounded-md border border-line-strong bg-surface p-2 text-sm" />
      </Dialog>
      <Dialog open={dialog === "rollback"} onClose={() => setDialog(null)} size="md" title="Roll back to the previous version?" footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setDialog(null)}>Cancel</Button><Button variant="danger" loading={busy === "rollback"} onClick={() => act("rollback")}>Roll back</Button></div>}>
        <p className="text-sm text-fg-muted">Restores the body, search title and meta description from before this draft, as a new revision (history is kept), then re-verifies the page and submits it again.</p>
      </Dialog>
    </div>
  );
}

function PublishedPanel({ initial, submissions, onRollback }: { initial: ReviewProps["draft"]; submissions: SubmissionRow[]; onRollback: () => void }) {
  const v = initial.verification;
  return (
    <section aria-labelledby="pub-h" className="mt-8 rounded-xl border border-line bg-surface p-4">
      <h2 id="pub-h" className="font-semibold text-fg">{initial.status === "rolled_back" ? "Rolled back" : "Published"}{initial.decidedBy ? ` by ${initial.decidedBy}` : ""}{initial.decidedAt ? <>, <LocalTime iso={initial.decidedAt} /></> : ""}</h2>
      <h3 className="mt-3 text-sm font-semibold text-fg">Live-page verification: {v?.state ?? "pending"}{v?.attempts ? ` (attempt ${v.attempts})` : ""}</h3>
      {v?.checks && <ul className="mt-1 grid gap-1 text-sm sm:grid-cols-2">{v.checks.map((c) => <li key={c.key} className={c.ok ? "text-emerald-800 dark:text-emerald-300" : "text-red-800 dark:text-red-300"}><span aria-hidden="true">{c.ok ? "✓" : "✕"}</span> <span className="sr-only">{c.ok ? "passed" : "failed"}: </span>{c.key.replace(/_/g, " ")} — {c.detail}</li>)}</ul>}
      {v?.state === "failed" && <p className="mt-2 text-sm text-red-800 dark:text-red-200">Nothing was submitted to search engines.</p>}
      <h3 className="mt-4 text-sm font-semibold text-fg">Search engines</h3>
      {submissions.length ? (
        <ol className="mt-1 space-y-1 text-sm text-fg-muted">
          {submissions.map((s, i) => (
            <li key={i}><span className="font-medium text-fg">{s.engine}</span> {s.kind} · {s.status}{s.responseCode ? ` (HTTP ${s.responseCode})` : ""} · <LocalTime iso={s.requestedAt} />{s.error ? ` — ${s.error}` : ""}{s.inspection ? ` — Google's last-known state: ${s.inspection.coverageState ?? s.inspection.verdict ?? "unknown"}${s.inspection.lastCrawlTime ? `, last crawled ${s.inspection.lastCrawlTime.slice(0, 10)}` : ""}` : ""}</li>
          ))}
        </ol>
      ) : <p className="mt-1 text-sm text-fg-subtle">Nothing submitted yet{v?.state === "passed" ? "" : " (waits for verification)"}.</p>}
      <p className="mt-2 text-xs text-fg-subtle">Submission is a crawl hint, not an indexing guarantee.</p>
      {initial.status === "published" && <Button className="mt-4" variant={v?.state === "failed" ? "danger" : "secondary"} size="sm" onClick={onRollback}>Roll back this change</Button>}
      <Link href="/admin/review" className={`${buttonClass("ghost", "sm")} mt-4 ml-2`}>Back to queue</Link>
    </section>
  );
}
