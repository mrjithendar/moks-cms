"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/form";

export function NewCalendarItem() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [notes, setNotes] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const input = "min-h-9 w-full rounded-md border border-line-strong bg-surface px-2 text-sm text-fg";
  return (
    <form
      className="grid gap-3 sm:grid-cols-[2fr_1fr]"
      onSubmit={async (e) => {
        e.preventDefault();
        const res = await fetch("/api/admin/seo/calendar", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, ...(date ? { targetDate: date, ...(time ? { targetTime: time } : {}) } : {}), ...(notes ? { notes } : {}) }) });
        const data = (await res.json().catch(() => ({}))) as { error?: string; issues?: string[]; draft?: unknown; draftError?: string };
        if (!res.ok) setMsg([data.error, ...(data.issues ?? [])].filter(Boolean).join(" "));
        else {
          setTitle("");
          setDate("");
          setTime("");
          setNotes("");
          setMsg(data.draftError ?? (data.draft ? "Added, and its draft post was created." : "Added."));
          router.refresh();
        }
      }}
    >
      <label className="grid gap-1 text-xs text-fg-subtle">Title<input required minLength={5} className={input} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      <label className="grid gap-1 text-xs text-fg-subtle">Target date and time (IST)<span className="flex gap-2"><input type="date" className={input} value={date} onChange={(e) => { setDate(e.target.value); if (!e.target.value) setTime(""); }} /><input type="time" aria-label="Target time (IST)" title={date ? "Optional time of day, India Standard Time" : "Choose a date first"} className={`${input} max-w-32`} value={time} disabled={!date} onChange={(e) => setTime(e.target.value)} /></span></label>
      <label className="grid gap-1 text-xs text-fg-subtle sm:col-span-2">Notes<textarea className={`${input} min-h-20 py-2`} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
      <div className="flex items-center gap-3"><Button type="submit" size="sm">Add to calendar</Button>{msg && <span role="status" className="text-xs">{msg}</span>}</div>
    </form>
  );
}
