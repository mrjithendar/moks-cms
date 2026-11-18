"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Dialog } from "@/components/admin/Dialog";
import { Button, buttonClass } from "@/components/ui/form";

type Result = { ok: boolean; text: string };

async function post(runId: string, body: unknown): Promise<{ ok: boolean; data: { runId?: string; existing?: boolean; error?: string; issues?: string[]; reference?: string } }> {
  try {
    const res = await fetch(`/api/admin/crewai/runs/${runId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { ok: res.ok, data: (await res.json().catch(() => ({}))) as never };
  } catch {
    return { ok: false, data: { error: "Network error." } };
  }
}

const message = (d: { error?: string; issues?: string[]; reference?: string }) => [d.error ?? "Something went wrong.", ...(d.issues ?? [])].join(" ") + (d.reference ? ` (ref ${d.reference})` : "");

/**
 * Cancel (while the run is going), Re-run (once it has finished: same inputs, or edited ones) and Copy run ID. `blocked`
 * says why this flow is not re-run from the console (drafting, publish, per-story news runs). A re-run opens the new run.
 */
export function RunActions({ runId, live, inputs, blocked }: { runId: string; live: boolean; inputs: Record<string, unknown>; blocked: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => JSON.stringify(inputs, null, 2));
  const [draftError, setDraftError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [menu]);

  const rerun = async (edited?: Record<string, unknown>) => {
    setBusy("rerun");
    setResult(null);
    const r = await post(runId, { action: "rerun", ...(edited ? { inputs: edited } : {}) });
    setBusy(null);
    if (!r.ok) {
      if (edited) setDraftError(message(r.data));
      else setResult({ ok: false, text: message(r.data) });
      return;
    }
    setEditing(false);
    if (r.data.existing) setResult({ ok: true, text: "A run of this flow for the same target is already going: opening it." });
    if (r.data.runId) router.push(`/admin/crewai/runs/${r.data.runId}`);
  };

  const cancel = async () => {
    if (!window.confirm("Cancel this run? Work already saved stays; the current step stops.")) return;
    setBusy("cancel");
    setResult(null);
    const r = await post(runId, { action: "cancel" });
    setBusy(null);
    setResult(r.ok ? { ok: true, text: "Cancelled." } : { ok: false, text: message(r.data) });
    router.refresh();
  };

  return (
    <div className="flex flex-col items-start gap-1 sm:items-end">
      <div className="flex flex-wrap gap-2">
        {live && (
          <Button type="button" variant="danger" size="sm" loading={busy === "cancel"} onClick={() => void cancel()}>
            Cancel run
          </Button>
        )}
        {!live && (
          <div ref={menuRef} className="relative inline-flex">
            <Button type="button" variant="secondary" size="sm" className="rounded-r-none" loading={busy === "rerun"} disabled={Boolean(blocked)} title={blocked ?? undefined} onClick={() => void rerun()}>
              Re-run
            </Button>
            <button type="button" className={`${buttonClass("secondary", "sm")} -ml-px rounded-l-none px-2`} aria-haspopup="menu" aria-expanded={menu} aria-label="More re-run options" disabled={Boolean(blocked)} onClick={() => setMenu((m) => !m)}>
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
            {menu && (
              <div role="menu" className="absolute right-0 top-full z-20 mt-1 w-64 rounded-lg border border-line bg-surface p-1 shadow-lg">
                <button type="button" role="menuitem" className="block w-full rounded-md px-3 py-2 text-left text-sm hover:bg-surface-muted" onClick={() => { setMenu(false); void rerun(); }}>
                  Re-run with the same inputs
                </button>
                <button type="button" role="menuitem" className="block w-full rounded-md px-3 py-2 text-left text-sm hover:bg-surface-muted" onClick={() => { setMenu(false); setDraftError(null); setEditing(true); }}>
                  Re-run with changed inputs…
                </button>
              </div>
            )}
          </div>
        )}
        <Button type="button" variant="ghost" size="sm" onClick={() => { void navigator.clipboard?.writeText(runId); setResult({ ok: true, text: "Run ID copied." }); }}>
          Copy run ID
        </Button>
      </div>
      {blocked && !live && <p className="max-w-sm text-xs text-fg-subtle sm:text-right">{blocked}</p>}
      {result && <p role="status" className={`text-xs ${result.ok ? "text-emerald-700 dark:text-emerald-300" : "text-red-700 dark:text-red-300"}`}>{result.text}</p>}
      <Dialog
        open={editing}
        onClose={() => setEditing(false)}
        title="Re-run with changed inputs"
        footer={
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setEditing(false)}>Close</Button>
            <Button
              type="button"
              loading={busy === "rerun"}
              onClick={() => {
                let parsed: unknown;
                try {
                  parsed = JSON.parse(draft || "{}");
                } catch {
                  setDraftError("The inputs are not valid JSON.");
                  return;
                }
                if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                  setDraftError("The inputs must be a JSON object.");
                  return;
                }
                void rerun(parsed as Record<string, unknown>);
              }}
            >
              Start run
            </Button>
          </div>
        }
      >
        <p className="mb-3 text-sm text-fg-muted">The flow checks the inputs against its own input model before it starts; a field it does not know is refused. The new run is a manual run in your name.</p>
        <label htmlFor="rerun-inputs" className="mb-1 block text-sm font-medium text-fg">Inputs (JSON)</label>
        <textarea id="rerun-inputs" value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} rows={12} aria-invalid={draftError ? true : undefined} aria-describedby={draftError ? "rerun-error" : undefined} className="block w-full rounded-lg border border-line-strong bg-surface p-3 font-mono text-sm text-fg" />
        {draftError && <p id="rerun-error" role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">{draftError}</p>}
      </Dialog>
    </div>
  );
}
