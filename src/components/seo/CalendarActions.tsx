"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, buttonClass } from "@/components/ui/form";
import { ApiButton } from "./ApiButton";

export type CalendarActionItem = {
  id: string;
  draft: "none" | "outline" | "writing" | "failed" | "ready" | "scheduled" | "published";
  postId: string | null;
  postPath: string | null;
  targetDate: string | null;
  targetTime: string | null;
};

async function send(url: string, method: string, body?: unknown) {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as { error?: string; issues?: string[]; note?: string | null; scheduled?: boolean; draftError?: string | null; draft?: unknown; unscheduled?: boolean };
  if (!res.ok) throw new Error([data.error ?? `HTTP ${res.status}`, ...(data.issues ?? [])].join(" "));
  return data;
}

/**
 * The actions on a calendar item, in the order a person works: generate the draft, improve it, open it, schedule it
 * (the post then publishes by itself at that time), unschedule, link a post written by hand, delete.
 */
export function CalendarActions({ item }: { item: CalendarActionItem }) {
  const router = useRouter();
  const [date, setDate] = useState(item.targetDate ?? "");
  const [time, setTime] = useState(item.targetTime ?? "");
  const [improving, setImproving] = useState(false);
  const [asks, setAsks] = useState("");
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const published = item.draft === "published";
  const base = `/api/admin/seo/calendar/${item.id}`;

  const run = async (what: string, fn: () => Promise<string>) => {
    setBusy(what);
    setMsg(null);
    try {
      setMsg({ ok: true, text: await fn() });
      router.refresh();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message || "Network error." });
    } finally {
      setBusy(null);
    }
  };
  const input = "min-h-9 rounded-md border border-line-strong bg-surface px-2 text-sm text-fg";

  return (
    <div className="mt-4 space-y-3 border-t border-line pt-4">
      <div className="flex flex-wrap items-center gap-2">
        {["none", "outline", "failed"].includes(item.draft) && (
          <ApiButton url={`${base}/draft`} label={item.draft === "failed" ? "Generate again" : "Generate draft"} variant="primary" confirm={item.draft === "none" ? undefined : "Start the SEO agent on this draft?"} />
        )}
        {(item.draft === "ready" || item.draft === "scheduled") && (
          <Button type="button" size="sm" variant={improving ? "secondary" : "primary"} aria-expanded={improving} onClick={() => setImproving((v) => !v)}>
            Improve
          </Button>
        )}
        {item.postId && !published && <Link className={buttonClass("secondary", "sm")} href={`/admin/posts/${item.postId}`}>Open draft</Link>}
        {published && item.postPath && <Link className={buttonClass("secondary", "sm")} href={item.postPath} target="_blank" rel="noopener">View post</Link>}
        {item.draft === "writing" && <span className="text-sm text-fg-muted">The SEO agent is writing the draft. This page shows it when it is ready.</span>}
        <span className="flex-1" />
        <ApiButton url={base} method="DELETE" label="Delete" variant="ghost" confirm={item.postId ? "Delete this item from the calendar? Its post is kept (a scheduled post goes back to draft)." : "Delete this item from the calendar?"} />
      </div>

      {improving && (
        <form
          className="grid gap-2 rounded-lg border border-line bg-surface-muted p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run("improve", async () => {
              const r = await send(`${base}/improve`, "POST", asks.trim() ? { instructions: asks.trim() } : {});
              setImproving(false);
              setAsks("");
              return r.unscheduled ? "Improving. The post went back to draft: review it, then schedule it again." : "Improving. The revised draft replaces the current one when it is ready, unless you edit the post meanwhile.";
            });
          }}
        >
          <label className="grid gap-1 text-sm font-medium text-fg">
            What should improve? <span className="font-normal text-fg-subtle">(optional)</span>
            <textarea className={`${input} min-h-20 py-2`} maxLength={1500} value={asks} onChange={(e) => setAsks(e.target.value)} placeholder="e.g. add a troubleshooting section, use Kubernetes 1.35, shorten the introduction" />
          </label>
          <p className="text-xs text-fg-subtle">The SEO agent reads the current draft, checks it against fresh research and returns a revised version.{item.draft === "scheduled" ? " The post is unscheduled until you schedule it again." : ""}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" loading={busy === "improve"}>Improve draft</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setImproving(false)}>Cancel</Button>
          </div>
        </form>
      )}

      {!published && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!date) return;
            void run("schedule", async () => {
              const r = await send(`${base}/schedule`, "POST", { date, time: time || null });
              if (r.scheduled) return `Scheduled. The post publishes by itself on ${date} at ${time || "09:00"} IST.`;
              return [r.note, r.draftError ?? (r.draft ? "The draft is being generated." : null)].filter(Boolean).join(" ");
            });
          }}
        >
          <label className="grid gap-1 text-xs font-medium text-fg-muted">
            Publish date
            <input type="date" required className={input} value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="grid gap-1 text-xs font-medium text-fg-muted">
            Time (IST)
            <input type="time" className={input} value={time} onChange={(e) => setTime(e.target.value)} title="India Standard Time; 09:00 when empty" />
          </label>
          <Button type="submit" size="sm" variant="secondary" loading={busy === "schedule"} disabled={!date}>
            {item.draft === "scheduled" ? "Reschedule" : "Schedule"}
          </Button>
          {item.targetDate && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              loading={busy === "unschedule"}
              onClick={() =>
                void run("unschedule", async () => {
                  await send(`${base}/schedule`, "DELETE");
                  setDate("");
                  setTime("");
                  return item.draft === "scheduled" ? "Unscheduled. The post is a draft again." : "Date cleared.";
                })
              }
            >
              Unschedule
            </Button>
          )}
        </form>
      )}

      {item.draft === "none" && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!link.trim()) return;
            void run("link", async () => {
              await send(base, "PATCH", { postId: link.trim() });
              setLink("");
              return "Linked.";
            });
          }}
        >
          <label className="grid gap-1 text-xs font-medium text-fg-muted">
            Or link a post you wrote (post id)
            <input className={`${input} w-72 max-w-full`} value={link} onChange={(e) => setLink(e.target.value)} placeholder="post id from its editor URL" />
          </label>
          <Button type="submit" size="sm" variant="secondary" loading={busy === "link"} disabled={!link.trim()}>Link</Button>
        </form>
      )}

      {msg && (
        <p role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "text-fg-muted" : "text-red-700 dark:text-red-300"}`}>
          {msg.text}
        </p>
      )}
    </div>
  );
}
