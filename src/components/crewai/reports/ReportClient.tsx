"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Alert, Button, buttonClass, inputClass } from "@/components/ui/form";

const TONES: Record<string, string> = {
  queued: "bg-surface-sunken text-fg-muted ring-slate-600/20",
  running: "bg-sky-50 text-sky-800 ring-sky-600/20 dark:bg-sky-500/10 dark:text-sky-300",
  completed: "bg-emerald-50 text-emerald-800 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300",
  failed: "bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-500/10 dark:text-red-300",
  cancelled: "bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300",
  sent: "bg-emerald-50 text-emerald-800 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300",
  retried: "bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300",
};

export function ReportStatus({ status }: { status: string }) {
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize ring-1 ring-inset ${TONES[status] ?? TONES.queued}`}>{status}</span>;
}

type Live = { status: string; progress: { step?: string; percent?: number; message?: string }; error: string | null };

/**
 * Follows a queued or running report: polls its status every few seconds, shows the step and a progress bar, and
 * reloads the page when it is done (with a notice, and the tab title says so too). Leaving the page does not stop it.
 */
export function ReportProgress({ id, initial }: { id: string; initial: Live }) {
  const router = useRouter();
  const [live, setLive] = useState(initial);
  const [lost, setLost] = useState(false);
  // Set when this page saw the report finish: the notice stays after the refresh (the page renders this component
  // whatever the status, so it is not unmounted when the server's new status arrives).
  const [finished, setFinished] = useState<string | null>(null);
  const done = !["queued", "running"].includes(live.status);
  const title = useRef<string | null>(null);
  useEffect(() => {
    if (done) return;
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/admin/crewai/reports/${id}`, { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const { report } = (await res.json()) as { report: Live };
        if (stop) return;
        setLost(false);
        setLive(report);
        if (!["queued", "running"].includes(report.status)) {
          setFinished(report.status);
          title.current ??= document.title;
          document.title = `${report.status === "completed" ? "✓ Report ready" : `Report ${report.status}`} · ${title.current}`;
          router.refresh();
        }
      } catch {
        if (!stop) setLost(true);
      }
    };
    const t = setInterval(tick, 3000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [id, done, router]);
  const pct = Math.max(2, Math.min(100, live.progress.percent ?? 0));
  if (done) {
    if (!finished) return null; // opened when it had already finished: nothing to announce
    return finished === "completed" ? (
      <p role="status" className="mb-4 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-950 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-100">The report is ready.</p>
    ) : (
      <p role="status" className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">The report {finished}. See below.</p>
    );
  }
  return (
    <div role="status" aria-live="polite" className="mb-6 rounded-lg border border-line bg-surface p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="font-medium text-fg">{live.progress.message ?? "Waiting to start"}</span>
        <span className="tabular-nums text-fg-subtle">{pct}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-surface-sunken" aria-hidden="true"><div className="h-2 rounded-full bg-accent transition-all" style={{ width: `${pct}%` }} /></div>
      <p className="mt-2 text-xs text-fg-subtle">Collecting data → AI analysis by the Report crew → PDF → files stored in R2. You can leave this page; the report keeps going.{lost ? " (Connection lost: retrying.)" : ""}</p>
    </div>
  );
}

async function call(url: string, method: string, body?: unknown) {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as { error?: string; issues?: string[]; id?: string };
  if (!res.ok) throw new Error([data.error ?? `HTTP ${res.status}`, ...(data.issues ?? [])].join(" "));
  return data;
}

/** Downloads, email, retry, cancel, generate again and delete (with confirmation) for one report. */
export function ReportActions({ id, status, files, kind, canEmail }: { id: string; status: string; files: string[]; kind: "console" | "briefing"; canEmail: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [emailOpen, setEmailOpen] = useState(false);
  const act = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const base = `/api/admin/crewai/reports/${id}`;
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {(["pdf", "html", "json", "csv"] as const).filter((f) => files.includes(f)).map((f, i) => (
          <a key={f} className={buttonClass(i === 0 && f === "pdf" ? "primary" : "secondary", "sm")} href={`${base}/download?format=${f}`}>{f === "pdf" ? "Download PDF" : f === "html" ? "HTML" : f.toUpperCase()}</a>
        ))}
        {canEmail && status === "completed" && <Button size="sm" variant="secondary" onClick={() => setEmailOpen((v) => !v)} aria-expanded={emailOpen}>Email…</Button>}
        {kind === "console" && ["queued", "running"].includes(status) && <Button size="sm" variant="secondary" loading={busy === "cancel"} onClick={() => act("cancel", async () => { await call(base, "POST", { action: "cancel" }); router.refresh(); })}>Cancel</Button>}
        {kind === "console" && ["failed", "cancelled"].includes(status) && <Button size="sm" loading={busy === "retry"} onClick={() => act("retry", async () => { await call(base, "POST", { action: "retry" }); router.refresh(); })}>Retry</Button>}
        {kind === "console" && <Button size="sm" variant="ghost" loading={busy === "again"} onClick={() => act("again", async () => { const r = await call(base, "POST", { action: "regenerate" }); router.push(`/admin/crewai/reports/${r.id}`); })}>Generate again</Button>}
        {kind === "console" && <Link className={buttonClass("ghost", "sm")} href={`/admin/crewai/reports/new?from=${id}`}>Edit and generate</Link>}
        <Button size="sm" variant="ghost" className="text-red-700 dark:text-red-300" loading={busy === "delete"} onClick={() => { if (window.confirm("Delete this report and its files? This cannot be undone.")) void act("delete", async () => { await call(base, "DELETE"); router.push("/admin/crewai/reports"); }); }}>Delete</Button>
      </div>
      {error && <Alert>{error}</Alert>}
      {emailOpen && <EmailDialog id={id} onSent={() => router.refresh()} />}
    </div>
  );
}

type Preview = { subject: string; text: string; html: string; mode: "attachment" | "link"; pdfBytes: number | null; maxBytes: number; linkHours: number; configuredRecipients: string[]; mailConfigured: boolean };

/**
 * Email a finished report: choose recipients (the configured ones and others), attach the PDF or send a link, and see
 * the email before sending. Sending queues one delivery per recipient; the history below the report shows each result.
 */
export function EmailDialog({ id, onSent }: { id: string; onSent?: () => void }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [to, setTo] = useState<Set<string>>(new Set());
  const [extra, setExtra] = useState("");
  const [attach, setAttach] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`/api/admin/crewai/reports/${id}/email?attach=${attach}`, { cache: "no-store" })
      .then(async (r) => {
        const d = (await r.json()) as { preview?: Preview; error?: string };
        if (!r.ok || !d.preview) throw new Error(d.error ?? `HTTP ${r.status}`);
        if (!live) return;
        setPreview(d.preview);
        setTo((cur) => (cur.size ? cur : new Set(d.preview!.configuredRecipients)));
      })
      .catch((e: Error) => live && setMsg({ ok: false, text: e.message }));
    return () => {
      live = false;
    };
  }, [id, attach]);
  const extras = extra.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const recipients = [...new Set([...to, ...extras])];
  const send = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await call(`/api/admin/crewai/reports/${id}/email`, "POST", { recipients, attach });
      setMsg({ ok: true, text: `Queued ${(r as { queued?: number }).queued ?? recipients.length} email(s). Their status shows under Email history.` });
      onSent?.();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Email this report" className="mt-2 grid gap-3 rounded-lg border border-line bg-surface p-4">
      {!preview && !msg && <div className="h-24 animate-pulse rounded-md bg-surface-sunken" aria-label="Loading the email preview" />}
      {preview && (
        <>
          {!preview.mailConfigured && <Alert tone="info">Email is not configured (Settings → Email): nothing can be sent until it is.</Alert>}
          {preview.configuredRecipients.length > 0 && (
            <fieldset className="flex flex-wrap gap-3">
              <legend className="mb-1 text-sm font-medium text-fg">Recipients</legend>
              {preview.configuredRecipients.map((r) => (
                <label key={r} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={to.has(r)} onChange={() => setTo((s) => { const n = new Set(s); if (n.has(r)) n.delete(r); else n.add(r); return n; })} /> {r}</label>
              ))}
            </fieldset>
          )}
          <label className="grid gap-1 text-sm font-medium text-fg">Other recipients<input className={inputClass} value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="name@example.com, …" /></label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={attach} onChange={(e) => setAttach(e.target.checked)} /> Attach the PDF when it fits</label>
          <p className="text-xs text-fg-subtle">
            {preview.pdfBytes === null ? "This report has no PDF: the email links to it in the admin." : preview.mode === "attachment" ? `The PDF (${Math.max(1, Math.round(preview.pdfBytes / 1024))} KB) will be attached, with a download link valid for ${preview.linkHours} hours.` : `The PDF will be sent as a download link valid for ${preview.linkHours} hours${attach ? " (it is too large to attach)" : ""}.`}
          </p>
          <details>
            <summary className="cursor-pointer text-sm font-medium text-fg">Preview: {preview.subject}</summary>
            <iframe title="Email preview" sandbox="" srcDoc={preview.html} className="mt-2 h-96 w-full rounded-md border border-line bg-white" />
          </details>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" onClick={send} loading={busy} disabled={!recipients.length || !preview.mailConfigured}>Send to {recipients.length} recipient(s)</Button>
          </div>
        </>
      )}
      {msg && <Alert tone={msg.ok ? "success" : "error"}>{msg.text}</Alert>}
    </section>
  );
}
