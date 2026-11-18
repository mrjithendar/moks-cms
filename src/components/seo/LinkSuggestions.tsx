"use client";

import { useState } from "react";

type Suggestion = {
  id: string;
  type: "internal_link" | "external_link";
  kind: "keyword" | "related" | "docs";
  location: { blockId: string | null; headingPath: string | null; field: null };
  before: string;
  after: string;
  target: string;
  rationale: string;
  excerpt: string;
};

const KIND: Record<Suggestion["kind"], string> = { keyword: "Your keyword", related: "Related article", docs: "Official docs" };

/**
 * Editor panel: link suggestions for the text as it is now (unsaved edits included). "Insert" wraps the existing words
 * in the link on the server and hands the new body back; the author saves as usual. External links are nofollow.
 */
export function LinkSuggestions({ postId, body, onApply }: { postId: string; body: string; onApply: (body: string) => void }) {
  const [items, setItems] = useState<Suggestion[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const call = async (url: string, payload: unknown) => {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const data = (await res.json().catch(() => ({}))) as { error?: string; suggestions?: Suggestion[]; body?: string };
    if (!res.ok) throw new Error(res.status === 403 ? "Link suggestions are for admins." : (data.error ?? "Something went wrong."));
    return data;
  };
  const load = async (text = body) => {
    setBusy(true);
    setErr(null);
    try {
      setItems((await call("/api/admin/seo/link-suggestions", { postId, body: text })).suggestions ?? []);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const insert = async (s: Suggestion) => {
    setBusy(true);
    setErr(null);
    try {
      const next = (await call("/api/admin/seo/link-suggestions/apply", { postId, body, change: { id: s.id, type: s.type, location: s.location, before: s.before, after: s.after, target: s.target } })).body!;
      onApply(next);
      setBusy(false);
      await load(next); // positions moved: re-plan against the new text
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2 text-sm" aria-busy={busy}>
      <p className="text-xs text-fg-subtle">Links from your keyword list, related articles and official docs, for the text as it is now. Insert wraps existing words; save the post to keep them.</p>
      <button type="button" onClick={() => void load()} disabled={busy} className="min-h-9 rounded-md border border-line-strong px-3 text-sm disabled:opacity-60">{items ? "Refresh suggestions" : "Suggest links"}</button>
      {err && <p role="alert" className="text-xs text-red-700 dark:text-red-300">{err}</p>}
      {items && !items.length && <p className="text-xs text-fg-subtle">No suggestions: the article is at its link limit, or nothing relevant is mentioned in eligible text.</p>}
      {items && items.length > 0 && (
        <ul className="space-y-2">
          {items.map((s) => (
            <li key={`${s.target}:${s.before}`} className="rounded-md border border-line p-2">
              <p className="text-xs text-fg-subtle">{KIND[s.kind]}{s.type === "external_link" ? " · nofollow" : ""}</p>
              <p className="mt-0.5"><mark className="rounded bg-accent-soft px-0.5 text-accent-text">{s.before}</mark> → <span className="break-all font-mono text-xs">{s.target}</span></p>
              <p className="mt-1 text-xs text-fg-muted [overflow-wrap:anywhere]">{s.excerpt}</p>
              <button type="button" onClick={() => void insert(s)} disabled={busy} className="mt-1 min-h-8 rounded-md bg-accent px-2.5 text-xs font-medium text-on-accent disabled:opacity-60">Insert link</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
