"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Dialog } from "@/components/admin/Dialog";
import { Button, Field, Input, Select, Textarea } from "@/components/ui/form";
import { cronError, nextFire } from "@/lib/news/cron";
import type { JsonSchema } from "@/lib/seo-agent/client";
import { ParamsForm } from "./ParamsForm";

export type ScheduleView = { id: string; name: string; flow: string; description: string; cron: string; timezone: string; inputs: Record<string, unknown>; enabled: boolean; builtin: boolean; defaults: { cron: string; timezone: string } | null };
export type FlowOption = { name: string; label: string; schema: JsonSchema | null };

type ApiError = { error?: string; issues?: string[]; reference?: string };
const message = (d: ApiError) => [d.error ?? "Something went wrong.", ...(d.issues ?? [])].join(" ") + (d.reference ? ` (ref ${d.reference})` : "");
const ZONES = ["Etc/UTC", "Asia/Kolkata", "Europe/London", "Europe/Berlin", "America/New_York", "America/Los_Angeles", "Asia/Singapore", "Australia/Sydney"];

async function send(url: string, method: string, body?: unknown): Promise<{ ok: boolean; data: ApiError & Record<string, unknown> }> {
  try {
    const res = await fetch(url, { method, headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { ok: res.ok, data: (await res.json().catch(() => ({}))) as never };
  } catch {
    return { ok: false, data: { error: "Network error." } };
  }
}

function Preview({ cron, timezone }: { cron: string; timezone: string }) {
  const err = cron.trim() ? cronError(cron, timezone) : "Enter a cron expression.";
  const next = useMemo(() => {
    if (err) return [];
    const out: Date[] = [];
    let from = new Date();
    for (let i = 0; i < 3; i++) {
      const n = nextFire(cron, timezone, from);
      if (!n) break;
      out.push(n);
      from = n;
    }
    return out;
  }, [cron, timezone, err]);
  if (err) return <span className="text-red-700 dark:text-red-300">{err}</span>;
  const fmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
  return <span>Next: {next.map((d) => fmt.format(d)).join(" · ") || "none within a year"} (your time)</span>;
}

function ScheduleDialog({ open, onClose, flows, current }: { open: boolean; onClose: () => void; flows: FlowOption[]; current: ScheduleView | null }) {
  const router = useRouter();
  const [name, setName] = useState(current?.name ?? "");
  const [flow, setFlow] = useState(current?.flow ?? flows[0]?.name ?? "");
  const [description, setDescription] = useState(current?.description ?? "");
  const [cron, setCron] = useState(current?.cron ?? "0 6 * * *");
  const [timezone, setTimezone] = useState(current?.timezone ?? "Etc/UTC");
  const [inputs, setInputs] = useState<Record<string, unknown>>(current?.inputs ?? {});
  const [enabled, setEnabled] = useState(current?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const schema = flows.find((f) => f.name === flow)?.schema ?? null;
  const [json, setJson] = useState(() => JSON.stringify(current?.inputs ?? {}, null, 2));

  const save = async () => {
    let body = inputs;
    if (!schema) {
      try {
        body = JSON.parse(json || "{}") as Record<string, unknown>;
      } catch {
        setError("The inputs must be one JSON object.");
        return;
      }
    }
    setBusy(true);
    setError(null);
    const r = current
      ? await send(`/api/admin/crewai/schedules/${current.id}`, "PATCH", { description, cron, timezone, inputs: body, enabled })
      : await send("/api/admin/crewai/schedules", "POST", { name, flow, description, cron, timezone, inputs: body, enabled });
    setBusy(false);
    if (!r.ok) {
      setError(message(r.data));
      return;
    }
    onClose();
    router.refresh();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={current ? `Edit ${current.name}` : "New schedule"}
      footer={
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Close</Button>
          <Button type="button" loading={busy} onClick={() => void save()}>{current ? "Save" : "Create schedule"}</Button>
        </div>
      }
    >
      <div className="space-y-4">
        {!current && (
          <>
            <Field label="Schedule name" htmlFor="sched-name" hint="Lower-case letters, digits and hyphens, for example report-quarterly. It names the runs it starts (schedule:<name>).">
              <Input id="sched-name" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} maxLength={64} autoComplete="off" spellCheck={false} />
            </Field>
            <Field label="Flow" htmlFor="sched-flow">
              <Select id="sched-flow" value={flow} onChange={(e) => { setFlow(e.target.value); setInputs({}); setJson("{}"); }}>
                {flows.map((f) => <option key={f.name} value={f.name}>{f.label} ({f.name})</option>)}
              </Select>
            </Field>
          </>
        )}
        <Field label="Description" htmlFor="sched-desc" optional>
          <Input id="sched-desc" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Cron expression" htmlFor="sched-cron" hint="minute hour day month weekday, e.g. 0 7 * * 1 (Mondays 07:00)">
            <Input id="sched-cron" value={cron} onChange={(e) => setCron(e.target.value)} className="font-mono" spellCheck={false} />
          </Field>
          <Field label="Time zone" htmlFor="sched-tz" hint="An IANA name, e.g. Etc/UTC or Asia/Kolkata">
            <Input id="sched-tz" value={timezone} onChange={(e) => setTimezone(e.target.value)} list="sched-zones" spellCheck={false} />
            <datalist id="sched-zones">{ZONES.map((z) => <option key={z} value={z} />)}</datalist>
          </Field>
        </div>
        <p className="text-sm text-fg-muted" aria-live="polite"><Preview cron={cron} timezone={timezone} /></p>
        <fieldset className="space-y-2 rounded-lg border border-line p-3">
          <legend className="px-1 text-sm font-medium text-fg">Inputs the run gets</legend>
          {schema ? (
            <ParamsForm schema={schema} value={inputs} onChange={setInputs} idPrefix="sched" />
          ) : (
            <>
              <label htmlFor="sched-inputs" className="block text-sm text-fg-muted">Inputs (JSON). The SEO agent is off, so its form is not shown; the dispatcher checks them at every start.</label>
              <Textarea id="sched-inputs" rows={4} value={json} onChange={(e) => setJson(e.target.value)} className="font-mono text-sm" spellCheck={false} />
            </>
          )}
        </fieldset>
        <label className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-fg">
          <input type="checkbox" className="h-4 w-4" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled (runs on its schedule)
        </label>
        <p className="text-xs text-fg-subtle">Saving a new time, time zone or switch never starts a run for a time that has already passed: the first run is the next time due.</p>
        {error && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
      </div>
    </Dialog>
  );
}

export function NewScheduleButton({ flows }: { flows: FlowOption[] }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(0);
  return (
    <>
      <Button type="button" size="sm" onClick={() => { setKey((k) => k + 1); setOpen(true); }}>New schedule</Button>
      {open && <ScheduleDialog key={key} open={open} onClose={() => setOpen(false)} flows={flows} current={null} />}
    </>
  );
}

/** Edit, Pause / Resume, Run now, Reset (built-in) and Delete (an admin's own) for one schedule. */
export function ScheduleRowActions({ schedule, flows, agentOn }: { schedule: ScheduleView; flows: FlowOption[]; agentOn: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const act = async (what: string, run: () => Promise<{ ok: boolean; data: ApiError & Record<string, unknown> }>, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(what);
    setNote(null);
    const r = await run();
    setBusy(null);
    if (!r.ok) {
      setNote({ ok: false, text: message(r.data) });
      return;
    }
    if (what === "run" && typeof r.data.runId === "string") {
      router.push(`/admin/crewai/runs/${r.data.runId}`);
      return;
    }
    router.refresh();
  };
  const url = `/api/admin/crewai/schedules/${schedule.id}`;
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap justify-end gap-1">
        <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(true)}>Edit</Button>
        <Button type="button" size="sm" variant="ghost" loading={busy === "toggle"} onClick={() => void act("toggle", () => send(url, "PATCH", { enabled: !schedule.enabled }))}>{schedule.enabled ? "Pause" : "Resume"}</Button>
        <Button type="button" size="sm" variant="ghost" disabled={!agentOn} title={agentOn ? undefined : "The SEO agent is off."} loading={busy === "run"} onClick={() => void act("run", () => send(url, "POST", { action: "run" }), `Start ${schedule.flow} now with this schedule's inputs?`)}>Run now</Button>
        {schedule.builtin && schedule.defaults && (schedule.defaults.cron !== schedule.cron || schedule.defaults.timezone !== schedule.timezone) && (
          <Button type="button" size="sm" variant="ghost" loading={busy === "reset"} onClick={() => void act("reset", () => send(url, "POST", { action: "reset" }), `Reset ${schedule.name} to ${schedule.defaults!.cron} (${schedule.defaults!.timezone})?`)}>Reset</Button>
        )}
        {!schedule.builtin && (
          <Button type="button" size="sm" variant="ghost" className="text-red-700 dark:text-red-300" loading={busy === "delete"} onClick={() => void act("delete", () => send(url, "DELETE"), `Delete the schedule ${schedule.name}? Runs it started stay in the history.`)}>Delete</Button>
        )}
      </div>
      {note && <p role="status" className={`max-w-xs text-right text-xs ${note.ok ? "text-emerald-700 dark:text-emerald-300" : "text-red-700 dark:text-red-300"}`}>{note.text}</p>}
      {editing && <ScheduleDialog open={editing} onClose={() => setEditing(false)} flows={flows} current={schedule} />}
    </div>
  );
}
