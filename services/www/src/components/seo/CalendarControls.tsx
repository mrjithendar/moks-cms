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
export function CalendarControls({ id, status, targetDate, targetTime = null, postId }: { id: string; status: string; targetDate: string | null; targetTime?: string | null; postId: string | null }) {
  const router = useRouter();
  const [date, setDate] = useState(targetDate ?? "");
  const [time, setTime] = useState(targetTime ?? "");
  const [link, setLink] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const patch = async (body: unknown) => {
    setErr(null);
    const res = await fetch(`/api/admin/seo/calendar/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = (await res.json().catch(() => ({}))) as { error?: string; draftError?: string };
    if (!res.ok) setErr(data.error ?? "Could not save.");
    else {
      // Scheduling an approved item creates its draft post automatically; say so if that part failed.
      if (data.draftError) setErr(data.draftError);
      router.refresh();
    }
  };
  const input = "min-h-9 rounded-md border border-line-strong bg-surface px-2 text-sm text-fg";
  return (
    <div className="mt-3 flex flex-wrap items-end gap-2">
      {(NEXT[status] ?? []).map((n) => <ApiButton key={n.to} url={`/api/admin/seo/calendar/${id}`} method="PATCH" body={{ status: n.to }} label={n.label} />)}
      {status !== "published" && (
        <>
          <label className="grid gap-1 text-xs text-fg-subtle">Target date
            <input type="date" className={input} value={date} onChange={(e) => setDate(e.target.value)} onBlur={() => { if (date !== (targetDate ?? "")) { if (!date) setTime(""); void patch({ targetDate: date || null }); } }} />
          </label>
          <label className="grid gap-1 text-xs text-fg-subtle">Time (IST)
            <input type="time" className={input} value={time} disabled={!date} title={date ? "Optional time of day, India Standard Time" : "Choose a date first"}
              onChange={(e) => setTime(e.target.value)} onBlur={() => date && time !== (targetTime ?? "") && void patch({ targetDate: date, targetTime: time || null })} />
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
