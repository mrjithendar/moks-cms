"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/form";

/**
 * One drafted promotion post: edit, copy, record that you posted it, or dismiss it. Posting is always done by the
 * admin on the channel itself; "Mark as posted" only records it (with the post's URL if you paste one).
 */
export function PromoDraftEditor({ id, label, hasTitle, title, body, maxChars, link, postUrl, status }: {
  id: string;
  label: string;
  hasTitle: boolean;
  title: string | null;
  body: string | null;
  maxChars: number;
  link: string;
  postUrl: string | null;
  status: "open" | "drafted" | "posted" | "dismissed";
}) {
  const router = useRouter();
  const [t, setT] = useState(title ?? "");
  const [b, setB] = useState(body ?? "");
  const [postedUrl, setPostedUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const dirty = t !== (title ?? "") || b !== (body ?? "");
  const input = "w-full rounded-md border border-line-strong bg-surface px-2 text-sm text-fg";

  async function send(payload: Record<string, unknown>, done: string) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/admin/seo/promotion/opportunities/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = (await res.json().catch(() => ({}))) as { error?: string; issues?: string[] };
      if (!res.ok) setMsg({ ok: false, text: [data.error ?? `HTTP ${res.status}`, ...(data.issues ?? [])].join(" ") });
      else {
        setMsg({ ok: true, text: done });
        router.refresh();
      }
    } catch {
      setMsg({ ok: false, text: "Network error." });
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      setMsg({ ok: true, text: `${what} copied.` });
    } catch {
      setMsg({ ok: false, text: "Copy failed: select the text and copy it yourself." });
    }
  }

  if (status === "posted" || status === "dismissed") {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button type="button" variant="secondary" size="sm" loading={busy} onClick={() => send({ action: "reopen" }, "Reopened.")}>Reopen</Button>
        {msg && <span role="status" className={`text-xs ${msg.ok ? "text-emerald-700 dark:text-emerald-300" : "text-red-700 dark:text-red-300"}`}>{msg.text}</span>}
      </div>
    );
  }

  return (
    <div className="mt-3 grid gap-2">
      {hasTitle && (
        <label className="grid gap-1 text-xs text-fg-subtle">
          Title
          <input className={`${input} min-h-9`} value={t} maxLength={300} onChange={(e) => setT(e.target.value)} />
        </label>
      )}
      <label className="grid gap-1 text-xs text-fg-subtle">
        <span>Text for {label} <span className={b.length > maxChars ? "font-semibold text-red-700 dark:text-red-300" : ""}>({b.length} / {maxChars} characters)</span></span>
        <textarea className={`${input} min-h-36 py-2`} value={b} maxLength={4000} onChange={(e) => setB(e.target.value)} />
      </label>
      <p className="text-xs text-fg-subtle [overflow-wrap:anywhere]">Tagged link: <code>{link}</code></p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" loading={busy} disabled={!b.trim() || !dirty} onClick={() => send({ action: "save", body: b, ...(hasTitle ? { title: t } : {}) }, "Saved.")}>Save</Button>
        <Button type="button" variant="secondary" size="sm" disabled={!b.trim()} onClick={() => copy(hasTitle && t.trim() ? `${t.trim()}\n\n${b}` : b, "Text")}>Copy text</Button>
        <Button type="button" variant="secondary" size="sm" onClick={() => copy(link, "Link")}>Copy link</Button>
        {postUrl && <a className="text-sm underline" href={postUrl} target="_blank" rel="noopener noreferrer">Open {label}</a>}
        <Button type="button" variant="secondary" size="sm" loading={busy} onClick={() => send({ action: "dismiss" }, "Dismissed.")}>Dismiss</Button>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid min-w-0 flex-1 gap-1 text-xs text-fg-subtle">
          After you post it: the post&apos;s URL (optional)
          <input type="url" inputMode="url" placeholder="https://" className={`${input} min-h-9`} value={postedUrl} onChange={(e) => setPostedUrl(e.target.value)} />
        </label>
        <Button type="button" variant="secondary" size="sm" loading={busy} disabled={dirty} title={dirty ? "Save your changes first" : undefined} onClick={() => send({ action: "posted", postedUrl: postedUrl.trim() }, "Recorded as posted.")}>Mark as posted</Button>
      </div>
      {msg && <span role="status" className={`text-xs ${msg.ok ? "text-emerald-700 dark:text-emerald-300" : "text-red-700 dark:text-red-300"}`}>{msg.text}</span>}
    </div>
  );
}
