"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Dialog } from "@/components/admin/Dialog";
import { Alert, Button, Input, Select, Textarea } from "@/components/ui/form";
import { Badge, StatusBadge } from "@/components/seo/badges";
import type { NewsArticleView } from "@/lib/news/service";
import { api, usd } from "./api";
import { Field } from "./Fld";

type Doc = { title: string; meta_description: string; body_mdx: string; incomplete?: boolean; incomplete_reason?: string | null; news?: { dek?: string; categories?: string[]; tags?: string[]; key_takeaways?: string[]; image?: { imageId?: string; src?: string; alt?: string; provider?: string; aiGenerated?: boolean; decorative?: boolean; stored?: boolean; error?: string } | null; schema_jsonld?: Record<string, unknown>; job_name?: string; edits?: number } };
type Flag = { code: string; severity: string; message: string };
const REJECT = [["off_topic", "Off-topic"], ["low_value", "Low value"], ["duplicate", "Duplicate"], ["inaccurate", "Inaccurate"], ["style", "Style"], ["other", "Other"]] as const;

/**
 * Review of a news desk draft. Everything shown comes from the run: the score breakdown (why it was picked), the
 * sources with the fact-sheet claims each supports, the similarity report and fact-check flags, the quality gates, the
 * cover (variants, regenerate, template, alt text). Edits are saved to the draft (tracked); approval publishes through
 * the existing approve → publish_flow path. Nothing publishes without the confirmation dialog.
 */
export function NewsReview({ draft, doc, html, news, categories, editorUrl, livePath }: { draft: { id: string; status: string; flags: Flag[]; failureReason: string | null; ageHours: number }; doc: Doc; html: string; news: NewsArticleView; categories: { slug: string; label: string }[]; editorUrl: string; livePath: string | null }) {
  const router = useRouter();
  const n = doc.news ?? {};
  const [edit, setEdit] = useState({ title: doc.title, meta_description: doc.meta_description, dek: n.dek ?? "", body_mdx: doc.body_mdx, categories: n.categories ?? [], tags: (n.tags ?? []).join(", "), alt: n.image?.alt ?? "" });
  const [dialog, setDialog] = useState<null | "publish" | "schedule" | "reject" | "correction">(null);
  const [reject, setReject] = useState<{ category: string; reason: string }>({ category: "low_value", reason: "" });
  const [slots, setSlots] = useState<string[]>([]);
  const [slot, setSlot] = useState("");
  const [prompt, setPrompt] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const open = draft.status === "ready_for_review";
  const ageH = draft.ageHours;
  const blocking = draft.flags.filter((f) => f.severity === "error");
  const gates = news.quality.gates ?? {};
  const b = (news.candidate?.breakdown ?? {}) as { features?: Record<string, { value: number; weight: number; contribution: number }>; model?: string; v1_score?: number };

  useEffect(() => {
    if (dialog === "schedule") api<{ slots: string[] }>(`/api/admin/news/drafts/${draft.id}/slots`).then((r) => { setSlots(r.slots); setSlot(r.slots[0] ?? ""); }).catch(() => setSlots([]));
  }, [dialog, draft.id]);

  async function act(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: ok });
      setDialog(null);
      router.refresh();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  const saveEdits = () =>
    act(() => api(`/api/admin/news/drafts/${draft.id}`, "PATCH", { title: edit.title, meta_description: edit.meta_description, dek: edit.dek, body_mdx: edit.body_mdx, categories: edit.categories.length ? edit.categories : undefined, tags: edit.tags.split(",").map((t) => t.trim()).filter(Boolean), ...(n.image?.src && edit.alt !== (n.image?.alt ?? "") ? { alt: edit.alt } : {}) }), "Edits saved to the draft (tracked for the style review).");

  const claimsBy = new Map<string, NonNullable<NewsArticleView["fact_sheet"]["claims"]>>();
  for (const c of news.fact_sheet.claims ?? []) claimsBy.set(c.source_url, [...(claimsBy.get(c.source_url) ?? []), c]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={draft.status} />
        <Badge t="blue">News · {String(news.job_name ?? n.job_name ?? "job")}</Badge>
        {news.mode === "digest" && <Badge t="violet">Digest</Badge>}
        <span className={`text-sm ${ageH >= 48 ? "font-medium text-amber-800 dark:text-amber-200" : "text-fg-subtle"}`}>{ageH < 48 ? `${ageH} h old` : `${Math.round(ageH / 24)} days old: news may be stale`}</span>
        <span className="text-sm text-fg-subtle">· draft cost {usd(news.cost_usd)}</span>
        <Link href={editorUrl} className="ml-auto text-sm underline">Open the CMS draft</Link>
      </div>
      {msg && <Alert tone={msg.ok ? "success" : "error"}>{msg.text}</Alert>}
      {doc.incomplete && <Alert>The crew stopped early: {doc.incomplete_reason ?? "a limit was reached"}. Finish it below or reject it.</Alert>}
      {blocking.length > 0 && <Alert>Resolve before approving: {blocking.map((f) => f.message).join(" · ")}</Alert>}

      <section aria-labelledby="why" className="rounded-xl border border-line p-4">
        <h2 id="why" className="text-sm font-semibold">Why this story was picked</h2>
        {news.candidate ? (
          <>
            <p className="mt-1 text-sm text-fg-muted">Score {Number(news.candidate.score).toFixed(3)} ({news.candidate.model_version}{b.v1_score !== undefined ? `; v1 ${b.v1_score.toFixed(3)}` : ""}). {news.candidate.reason}</p>
            <ul className="mt-2 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
              {Object.entries(b.features ?? {}).sort((x, y) => y[1].contribution - x[1].contribution).map(([k, v]) => (
                <li key={k} className="flex justify-between gap-2"><span>{k.replace(/_/g, " ")}</span><span className="tabular-nums">{v.value.toFixed(2)} × {v.weight.toFixed(2)} = {v.contribution.toFixed(3)}</span></li>
              ))}
            </ul>
          </>
        ) : (
          <p className="mt-1 text-sm text-fg-subtle">No candidate record (playground or digest).</p>
        )}
      </section>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="space-y-6">
          <section aria-labelledby="edit" className="space-y-4 rounded-xl border border-line p-4">
            <h2 id="edit" className="text-sm font-semibold">Article {n.edits ? <span className="font-normal text-fg-subtle">· edited {n.edits}×</span> : null}</h2>
            <Field label={`Title (${edit.title.length}/60)`}><Input value={edit.title} disabled={!open} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></Field>
            <Field label={`Meta description (${edit.meta_description.length}, 110–160)`}><Textarea rows={2} value={edit.meta_description} disabled={!open} onChange={(e) => setEdit({ ...edit, meta_description: e.target.value })} /></Field>
            <Field label="Dek"><Input value={edit.dek} disabled={!open} onChange={(e) => setEdit({ ...edit, dek: e.target.value })} /></Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Category">
                <Select value={edit.categories[0] ?? ""} disabled={!open} onChange={(e) => setEdit({ ...edit, categories: e.target.value ? [e.target.value] : [] })}>
                  <option value="">—</option>
                  {categories.map((c) => <option key={c.slug} value={c.slug}>{c.label}</option>)}
                </Select>
              </Field>
              <Field label="Tags (comma separated)"><Input value={edit.tags} disabled={!open} onChange={(e) => setEdit({ ...edit, tags: e.target.value })} /></Field>
            </div>
            <Field label="Body (MDX)" hint="Edit here; the draft keeps the generated version for comparison. Code quality gates ran on the generated version."><Textarea rows={16} className="font-mono text-xs" value={edit.body_mdx} disabled={!open} onChange={(e) => setEdit({ ...edit, body_mdx: e.target.value })} /></Field>
            {open && <Button variant="secondary" disabled={busy} onClick={saveEdits}>Save edits</Button>}
          </section>
          <section aria-labelledby="prev" className="rounded-xl border border-line p-4">
            <h2 id="prev" className="mb-3 text-sm font-semibold">Preview</h2>
            <div className="prose max-w-none dark:prose-invert" dangerouslySetInnerHTML={{ __html: html }} />
            <p className="mt-4 text-xs text-fg-subtle">The site adds the Sources section, cover, author box and NewsArticle structured data from the post&apos;s fields.</p>
          </section>
        </div>

        <div className="space-y-6">
          <section aria-labelledby="cover" className="space-y-3 rounded-xl border border-line p-4">
            <h2 id="cover" className="text-sm font-semibold">Cover image</h2>
            {n.image?.src ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={n.image.src} alt={n.image.alt ?? ""} className="aspect-video w-full rounded-lg object-cover" />
            ) : (
              <p className="text-sm text-fg-subtle">{n.image?.error ? `Not stored: ${n.image.error}` : "No cover."}</p>
            )}
            {n.image && <p className="text-xs text-fg-subtle">{n.image.provider}{n.image.aiGenerated ? " · AI-generated" : " · template (not AI)"}{n.image.decorative ? " · decorative per the vision check" : ""}</p>}
            {n.image?.src && <Field label={`Alt text (${edit.alt.length}, aim 80–125)`} hint="Written by a vision model looking at this image. Edit, then “Save edits”."><Textarea rows={2} value={edit.alt} disabled={!open} onChange={(e) => setEdit({ ...edit, alt: e.target.value })} /></Field>}
            {open && (
              <>
                <Field label="Prompt tweak (optional)"><Input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="e.g. cooler colours, more space" /></Field>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => act(() => api(`/api/admin/news/drafts/${draft.id}/image`, "POST", { action: "regenerate", prompt }), "Regenerating; refresh in a minute.")}>Regenerate</Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => api(`/api/admin/news/drafts/${draft.id}/image`, "POST", { action: "template" }), "Switching to the template cover…")}>Use template cover</Button>
                </div>
              </>
            )}
            {news.images.filter((i) => i.src).length > 1 && (
              <ul className="grid grid-cols-3 gap-2">
                {news.images.filter((i) => i.src).map((i) => (
                  <li key={String(i.id)}>
                    <button type="button" disabled={!open || busy} onClick={() => act(() => api(`/api/admin/news/drafts/${draft.id}/image`, "POST", { action: "choose", imageId: i.id }), "Cover changed.")} className={`block w-full overflow-hidden rounded border-2 ${i.selected ? "border-accent" : "border-transparent"}`} aria-pressed={Boolean(i.selected)} aria-label={`Use this cover (${String(i.provider)})`}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={String(i.src)} alt="" className="aspect-video w-full object-cover" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {news.images.some((i) => i.status === "rejected_safety") && <p className="text-xs text-fg-subtle">{news.images.filter((i) => i.status === "rejected_safety").length} generated variant(s) were rejected by the safety check (faces, logos or text).</p>}
          </section>

          <section aria-labelledby="src" className="rounded-xl border border-line p-4">
            <h2 id="src" className="text-sm font-semibold">Sources and claims</h2>
            <ul className="mt-2 space-y-3 text-sm">
              {news.sources.map((s) => (
                <li key={s.url}>
                  <a href={s.url} target="_blank" rel="noreferrer noopener" className="font-medium underline [overflow-wrap:anywhere]">{s.title || s.url}</a>
                  <span className="text-xs text-fg-subtle"> · {s.publisher}</span>
                  <ul className="mt-1 space-y-1 border-l-2 border-line pl-3 text-xs">
                    {(claimsBy.get(s.url) ?? []).map((c, i) => <li key={i}><mark className="rounded bg-yellow-100 px-0.5 dark:bg-yellow-500/20">{c.claim}</mark>{c.snippet && <span className="text-fg-subtle"> — “{c.snippet}”</span>}</li>)}
                    {!(claimsBy.get(s.url) ?? []).length && <li className="text-fg-subtle">No fact-sheet claims cite this source.</li>}
                  </ul>
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="qg" className="rounded-xl border border-line p-4 text-sm">
            <h2 id="qg" className="font-semibold">Quality gates</h2>
            <ul className="mt-2 space-y-2">
              {Object.entries(gates).map(([g, r]) => (
                <li key={g}>
                  <span className={r.passed ? "text-emerald-700 dark:text-emerald-300" : "font-semibold text-red-700 dark:text-red-300"}>{r.passed ? "✓" : "✕"} {g.replace(/_/g, " ")}</span>
                  {[...r.failures, ...r.warnings].slice(0, 4).map((m, i) => <p key={i} className="text-xs text-fg-subtle [overflow-wrap:anywhere]">{m}</p>)}
                </li>
              ))}
            </ul>
            {(news.similarity.detail?.top_matches ?? []).length > 0 && (
              <details className="mt-3"><summary className="cursor-pointer text-xs font-semibold">Closest passages to the sources</summary>
                <ul className="mt-2 space-y-2 text-xs">{(news.similarity.detail?.top_matches ?? []).slice(0, 5).map((m, i) => <li key={i} className="rounded border border-line p-2">¶{m.paragraph + 1} vs {new URL(m.source).hostname}: {m.overlap !== undefined ? `${(m.overlap * 100).toFixed(0)}% 8-gram overlap, run ${m.longest_run ?? 0} words` : `cosine ${m.cosine?.toFixed(2)}`}<p className="text-fg-subtle">{m.excerpt}</p></li>)}</ul>
              </details>
            )}
            {(news.fact_check.flagged ?? []).length > 0 && (
              <div className="mt-3"><p className="text-xs font-semibold">Fact-check flags</p><ul className="text-xs">{(news.fact_check.flagged ?? []).map((f, i) => <li key={i} className={f.severity === "error" ? "text-red-700 dark:text-red-300" : ""}>{f.claim}: {f.reason}</li>)}</ul></div>
            )}
            {(news.fact_check.removed ?? []).length > 0 && <p className="mt-2 text-xs text-fg-subtle">Removed by the fact-checker: {(news.fact_check.removed ?? []).join("; ")}</p>}
          </section>
        </div>
      </div>

      {open && (
        <div className="sticky bottom-0 z-10 flex flex-wrap gap-2 border-t border-line bg-surface py-3">
          <Button disabled={busy || blocking.length > 0} onClick={() => setDialog("publish")}>Approve &amp; publish</Button>
          <Button variant="secondary" disabled={busy || blocking.length > 0} onClick={() => setDialog("schedule")}>Schedule…</Button>
          <Button variant="ghost" disabled={busy} onClick={() => setDialog("reject")}>Reject…</Button>
        </div>
      )}
      {draft.status === "published" && livePath && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line p-4 text-sm">
          <span>Published at <Link className="underline" href={livePath}>{livePath}</Link>.</span>
          <Button size="sm" variant="secondary" onClick={() => setDialog("correction")}>Add correction / update</Button>
        </div>
      )}

      <Dialog open={dialog === "publish"} onClose={() => setDialog(null)} title="Approve and publish this news article" footer={<><Button variant="ghost" onClick={() => setDialog(null)}>Cancel</Button><Button disabled={busy} onClick={() => act(() => api(`/api/admin/seo/drafts/${draft.id}/approve`, "POST", {}), "Approved: publishing, verifying and submitting…")}>Approve &amp; publish</Button></>}>
        <p className="text-sm">The article goes live with its sources, category, tags and cover, then the live page is verified and submitted (IndexNow, sitemaps incl. the news sitemap). Save unsaved edits first.</p>
      </Dialog>
      <Dialog open={dialog === "schedule"} onClose={() => setDialog(null)} title="Schedule into a publishing slot" footer={<><Button variant="ghost" onClick={() => setDialog(null)}>Cancel</Button><Button disabled={busy || !slot} onClick={() => act(() => api(`/api/admin/seo/drafts/${draft.id}/approve`, "POST", { publishAt: slot }), "Scheduled.")}>Approve for this slot</Button></>}>
        {slots.length ? (
          <Field label="Slot"><Select value={slot} onChange={(e) => setSlot(e.target.value)}>{slots.map((s) => <option key={s} value={s}>{new Date(s).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}</option>)}</Select></Field>
        ) : (
          <p className="text-sm text-fg-muted">This job has no publishing slots (job editor → Schedule &amp; limits).</p>
        )}
      </Dialog>
      <Dialog open={dialog === "reject"} onClose={() => setDialog(null)} title="Reject this draft" footer={<><Button variant="ghost" onClick={() => setDialog(null)}>Cancel</Button><Button variant="danger" disabled={busy} onClick={() => act(() => api(`/api/admin/news/drafts/${draft.id}/reject`, "POST", { category: reject.category, reason: reject.reason || null }), "Rejected.")}>Reject</Button></>}>
        <Field label="Reason" hint="Used to improve ranking and source weights."><Select value={reject.category} onChange={(e) => setReject({ ...reject, category: e.target.value })}>{REJECT.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
        <div className="mt-3"><Field label="Note (optional)"><Textarea rows={3} value={reject.reason} onChange={(e) => setReject({ ...reject, reason: e.target.value })} /></Field></div>
      </Dialog>
      <Dialog open={dialog === "correction"} onClose={() => setDialog(null)} title="Add a correction or update" footer={<><Button variant="ghost" onClick={() => setDialog(null)}>Cancel</Button><Button disabled={busy || note.trim().length < 10} onClick={() => act(() => api(`/api/admin/news/posts/${String(news.post_id)}/correction`, "POST", { note }), "Correction added; dateModified updated and the page resubmitted.")}>Add</Button></>}>
        <Field label="Correction (shown dated on the article)"><Textarea rows={4} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </Dialog>
    </div>
  );
}
