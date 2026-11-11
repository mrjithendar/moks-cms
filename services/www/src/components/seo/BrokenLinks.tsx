"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { LocalTime } from "@/components/LocalTime";

type Occurrence = { kind: "post" | "page"; id: string; title: string; path: string };
type Problem = { url: string; internal: boolean; status: string; httpStatus: number | null; finalUrl: string | null; error: string | null; checkedAt: string; where: Occurrence[] };

/** Broken (or moved) links with the content they appear in, and one-click fixes for posts. */
export function BrokenLinks({ problems, moved = false }: { problems: Problem[]; moved?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Record<string, string>>({});
  const fix = async (p: Problem, o: Occurrence, replacement: string | null) => {
    const key = `${p.url}|${o.id}`;
    setBusy(key);
    const res = await fetch("/api/admin/seo/broken-links/fix", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ postId: o.id, url: p.url, replacement }) });
    const data = (await res.json().catch(() => ({}))) as { error?: string; issues?: string[] };
    setBusy(null);
    setMsg((m) => ({ ...m, [key]: res.ok ? "Fixed and published (live check running; rollback from the article's SEO page if needed)." : [data.error, ...(data.issues ?? [])].filter(Boolean).join(" ") }));
    if (res.ok) router.refresh();
  };
  return (
    <ul className="grid gap-3">
      {problems.map((p) => (
        <li key={p.url} className="rounded-xl border border-line bg-surface p-4 text-sm">
          <p className="break-all font-mono text-xs text-fg">{p.url}</p>
          <p className="mt-1 text-xs text-fg-subtle">
            {moved ? <>Moved to <span className="break-all font-mono">{p.finalUrl}</span></> : p.status === "broken" ? `Not found (HTTP ${p.httpStatus ?? 404})` : `Failing: ${p.error ?? `HTTP ${p.httpStatus}`}`}
            {" · "}{p.internal ? "internal" : "external"} · checked <LocalTime iso={p.checkedAt} />
          </p>
          <ul className="mt-2 space-y-2">
            {p.where.map((o) => {
              const key = `${p.url}|${o.id}`;
              return (
                <li key={key} className="flex flex-wrap items-center gap-2">
                  <span className="text-fg-muted">in</span>
                  {o.kind === "post" ? <Link className="underline" href={`/admin/posts/${o.id}/insights`}>{o.title}</Link> : <Link className="underline" href={`/admin/pages`}>{o.title} (page)</Link>}
                  {o.kind === "post" ? (
                    <>
                      {moved && p.finalUrl && <button type="button" disabled={busy === key} className="min-h-8 rounded-md bg-accent px-2 text-xs font-medium text-on-accent disabled:opacity-60" onClick={() => void fix(p, o, p.finalUrl)}>Update to new URL</button>}
                      {!moved && (
                        <form className="flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); const v = String(new FormData(e.currentTarget).get("to") ?? "").trim(); if (v) void fix(p, o, v); }}>
                          <input name="to" aria-label="Replacement URL" placeholder="/blog/… or https://…" className="min-h-8 w-56 rounded-md border border-line-strong bg-surface px-2 text-xs text-fg" />
                          <button type="submit" disabled={busy === key} className="min-h-8 rounded-md bg-accent px-2 text-xs font-medium text-on-accent disabled:opacity-60">Replace</button>
                        </form>
                      )}
                      {!moved && <button type="button" disabled={busy === key} className="min-h-8 rounded-md border border-line-strong px-2 text-xs disabled:opacity-60" onClick={() => window.confirm("Remove the link and keep its text?") && void fix(p, o, null)}>Unlink</button>}
                    </>
                  ) : <span className="text-xs text-fg-subtle">fix it in the page editor</span>}
                  {msg[key] && <span role="status" className="w-full text-xs text-fg-muted">{msg[key]}</span>}
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ul>
  );
}
