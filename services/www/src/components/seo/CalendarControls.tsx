"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ApiButton } from "./ApiButton";

const NEXT: Record<string, { to: string; label: string }[]> = {
  suggested: [{ to: "approved", label: "Approve" }, { to: "dropped", label: "Drop" }],
  approved: [{ to: "drafting", label: "Mark drafting" }, { to: "dropped", label: "Drop" }],
  drafting: [{ to: "in_review", label: "Send to review" }, { to: "dropped", label: "Drop" }],
  in_review: [{ to: "drafting", label: "Back to drafting" }, { to: "dropped", label: "Drop" }],
  dropped: [{ to: "suggested", label: "Restore" }],
  published: [],
};

/** Status buttons (flow-checked on the server), target date, link an existing post, create a draft. */
export function CalendarControls({ id, status, targetDate, postId }: { id: string; status: string; targetDate: string | null; postId: string | null }) {
  const router = useRouter();
  const [date, setDate] = useState(targetDate ?? "");
  const [link, setLink] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const patch = async (body: unknown) => {
    setErr(null);
    const res = await fetch(`/api/admin/seo/calendar/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) setErr(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Could not save.");
    else router.refresh();
  };
  const input = "min-h-9 rounded-md border border-line-strong bg-surface px-2 text-sm text-fg";
  return (
    <div className="mt-3 flex flex-wrap items-end gap-2">
      {(NEXT[status] ?? []).map((n) => <ApiButton key={n.to} url={`/api/admin/seo/calendar/${id}`} method="PATCH" body={{ status: n.to }} label={n.label} />)}
      {status !== "published" && (
        <>
          <label className="grid gap-1 text-xs text-fg-subtle">Target date
            <input type="date" className={input} value={date} onChange={(e) => setDate(e.target.value)} onBlur={() => date !== (targetDate ?? "") && void patch({ targetDate: date || null })} />
          </label>
          {!postId && (status === "approved" || status === "drafting") && <ApiButton url={`/api/admin/seo/calendar/${id}/draft`} label="Create draft post" variant="primary" />}
          {!postId && (
            <form className="flex items-end gap-1" onSubmit={(e) => { e.preventDefault(); if (link.trim()) void patch({ postId: link.trim() }); }}>
              <label className="grid gap-1 text-xs text-fg-subtle">Link existing post (id)
                <input className={input} value={link} onChange={(e) => setLink(e.target.value)} placeholder="post uuid" />
              </label>
              <button type="submit" className="min-h-9 rounded-md border border-line-strong px-3 text-sm">Link</button>
            </form>
          )}
        </>
      )}
      {err && <p role="alert" className="w-full text-xs text-red-700 dark:text-red-300">{err}</p>}
    </div>
  );
}
