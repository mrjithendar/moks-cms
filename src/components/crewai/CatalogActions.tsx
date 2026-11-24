"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api } from "@/components/news/api";
import { Alert, Button, Input } from "@/components/ui/form";
import { itemHref, type CatalogKind } from "@/lib/crewai/catalog-shared";
import { ConfirmDialog } from "./ConfirmDialog";

export type ActionItem = { kind: CatalogKind; key: string; label: string; enabled: boolean; deleted: boolean; definition: string };

type Pending = null | "disable" | "delete" | "duplicate";

const base = (i: ActionItem) => `/api/admin/crewai/catalog/${i.kind === "crew" ? "crews" : "flows"}/${i.key}`;

/**
 * Switch on or off, duplicate, delete and restore one crew or flow: the same actions for every crew and every flow
 * (D-100). `compact`: a "More actions" menu for a list row; otherwise buttons for a crew's or flow's page header.
 */
export function CatalogActions({ item, compact = false }: { item: ActionItem; compact?: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [copy, setCopy] = useState({ key: `${item.key.replace(/_flow$/, "")}_copy`.slice(0, 40), label: `${item.label} (copy)`.slice(0, 120) });
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const one = item.kind === "crew" ? "crew" : "flow";

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !menu.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const run = async (fn: () => Promise<unknown>, after?: (r: unknown) => void) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      setPending(null);
      after?.(r);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = () => (item.enabled ? setPending("disable") : run(() => api(base(item), "POST", { action: "enable" })));
  const restore = () => run(() => api(base(item), "POST", { action: "restore" }));
  const actions = item.deleted
    ? [{ label: "Restore", onClick: restore }]
    : [
        { label: item.enabled ? "Switch off" : "Switch on", onClick: toggle },
        { label: "Duplicate", onClick: () => setPending("duplicate") },
        { label: "Delete", onClick: () => setPending("delete"), danger: true },
      ];

  return (
    <>
      {compact ? (
        <div ref={menu} className="relative">
          <button type="button" aria-haspopup="menu" aria-expanded={open} aria-label={`Actions for ${item.label}`} onClick={() => setOpen((v) => !v)} className="inline-flex min-h-9 min-w-9 items-center justify-center rounded-md text-fg-muted hover:bg-surface-sunken hover:text-fg">
            <span aria-hidden="true">⋯</span>
          </button>
          {open && (
            <div role="menu" className="absolute right-0 z-20 mt-1 w-44 rounded-lg border border-line bg-surface py-1 shadow-lg">
              <Link role="menuitem" href={itemHref(item)} className="block px-3 py-2 text-sm text-fg hover:bg-surface-muted">Open</Link>
              {actions.map((a) => (
                <button key={a.label} role="menuitem" type="button" disabled={busy} onClick={() => { setOpen(false); a.onClick(); }} className={`block w-full px-3 py-2 text-left text-sm hover:bg-surface-muted ${"danger" in a && a.danger ? "text-red-700 dark:text-red-300" : "text-fg"}`}>
                  {a.label}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {actions.map((a) => (
            <Button key={a.label} variant={"danger" in a && a.danger ? "ghost" : "secondary"} disabled={busy} onClick={a.onClick} className={"danger" in a && a.danger ? "text-red-700 dark:text-red-300" : ""}>
              {a.label}
            </Button>
          ))}
        </div>
      )}
      {error && !pending && <div className="mt-2"><Alert tone="error">{error}</Alert></div>}
      {notes.length > 0 && <div className="mt-2"><Alert tone="info">{notes.join(" ")}</Alert></div>}

      <ConfirmDialog open={pending === "disable"} title={`Switch off ${item.label}?`} confirmLabel="Switch off" busy={busy} onCancel={() => setPending(null)} onConfirm={() => run(() => api(base(item), "POST", { action: "disable", ...(reason.trim() ? { reason: reason.trim() } : {}) }))}>
        <p>{item.kind === "flow" ? "Nobody can start it until it is switched on again: not a person, a schedule, another flow or MCP. Runs already going finish." : "Flows cannot run it until it is switched on again. A crew a flow that is on runs cannot be switched off."}</p>
        {item.kind === "flow" && (
          <label className="block space-y-1">
            <span className="font-medium text-fg">Reason (optional)</span>
            <Input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="Shown to whoever tries to start it" />
          </label>
        )}
        {error && <Alert tone="error">{error}</Alert>}
      </ConfirmDialog>

      <ConfirmDialog open={pending === "delete"} title={`Delete ${item.label}?`} confirmLabel={`Delete ${one}`} busy={busy} onCancel={() => setPending(null)} onConfirm={() => run(() => api(base(item), "DELETE"), () => router.push(item.kind === "crew" ? "/admin/crewai/crews" : "/admin/crewai/flows"))}>
        <p>It is switched off and hidden from the list. Its run history stays, and you can restore it from the list&apos;s <strong>Deleted</strong> filter.</p>
        {item.kind === "flow" && <p>{item.definition === "spec" ? "Its schedules are removed." : item.definition === "content" ? "Its content flow settings are deleted with it (restorable)." : "Its schedules are paused."}</p>}
        {item.kind === "crew" && <p>A crew that a flow still runs cannot be deleted: change or delete those flows first.</p>}
        {error && <Alert tone="error">{error}</Alert>}
      </ConfirmDialog>

      <ConfirmDialog
        open={pending === "duplicate"}
        title={`Duplicate ${item.label}`}
        confirmLabel="Duplicate"
        tone="primary"
        busy={busy}
        onCancel={() => setPending(null)}
        onConfirm={() =>
          run(
            () => api<{ item: { key: string; kind: CatalogKind }; notes: string[] }>(base(item), "POST", { action: "duplicate", ...(item.definition === "content" ? { label: copy.label } : copy) }),
            (r) => {
              const out = r as { item: { key: string; kind: CatalogKind }; notes: string[] };
              setNotes(out.notes ?? []);
              router.push(itemHref(out.item));
            },
          )
        }
      >
        <p>The copy is switched off until you have checked it, and every part of it can be edited{item.definition === "code" ? (item.kind === "crew" ? ": its agents and tasks come from the version this crew runs now" : ": its one step starts this flow, and you add steps around it") : ""}.</p>
        {item.definition !== "content" && (
          <label className="block space-y-1">
            <span className="font-medium text-fg">Key</span>
            <Input value={copy.key} onChange={(e) => setCopy({ ...copy, key: e.target.value.trim() })} pattern="[a-z][a-z0-9_]{1,39}" aria-describedby="dup-key-hint" />
            <span id="dup-key-hint" className="block text-xs text-fg-subtle">2–40 lower-case letters, digits or _; it cannot change later.</span>
          </label>
        )}
        <label className="block space-y-1">
          <span className="font-medium text-fg">Name</span>
          <Input value={copy.label} maxLength={120} onChange={(e) => setCopy({ ...copy, label: e.target.value })} />
        </label>
        {error && <Alert tone="error">{error}</Alert>}
      </ConfirmDialog>
    </>
  );
}
