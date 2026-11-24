"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Alert, Button, inputClass } from "@/components/ui/form";

export type ReportOptions = {
  presets: { key: string; label: string }[];
  categories: { key: string; label: string; description: string; sources: string[]; scoped: boolean }[];
  sources: { key: string; label: string; status: string; detail: string; categories: string[] }[];
  crews: { key: string; label: string }[];
  flows: { key: string; label: string; crews: string[] }[];
  recipients: string[];
  mailConfigured: boolean;
  storageReady: boolean;
  agentOn: boolean;
  /** Today in India Standard Time (from the server: the latest date a custom range may end on). */
  today: string;
};
export type ReportDefaults = { title?: string; preset?: string; start?: string; end?: string; categories?: string[]; crews?: string[] | "all"; flows?: string[] | "all"; sources?: string[] | "all"; email?: boolean };

const STATUS: Record<string, { label: string; cls: string }> = {
  ok: { label: "available", cls: "bg-emerald-100 text-emerald-900 dark:bg-emerald-500/15 dark:text-emerald-200" },
  empty: { label: "no data yet", cls: "bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-200" },
  unavailable: { label: "not available", cls: "bg-surface-sunken text-fg-muted" },
};
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Generate a report (CrewAI console → Reports → New report, and SEO-AI Reports → Generate and email): dates, categories
 * (one, several or all = site-wide), crews and flows, data sources (as found on this site now), and optionally the email
 * to send when it is done. Submitting queues it and opens its page, which follows its progress.
 */
export function ReportForm({ options, defaults = {} }: { options: ReportOptions; defaults?: ReportDefaults }) {
  const router = useRouter();
  const today = options.today;
  const [title, setTitle] = useState(defaults.title ?? "");
  const [preset, setPreset] = useState(defaults.preset ?? "last_7_days");
  const [start, setStart] = useState(defaults.start ?? "");
  const [end, setEnd] = useState(defaults.end ?? today);
  const [cats, setCats] = useState<Set<string>>(new Set(defaults.categories ?? options.categories.map((c) => c.key)));
  const [crews, setCrews] = useState<Set<string> | "all">(defaults.crews && defaults.crews !== "all" ? new Set(defaults.crews) : "all");
  const [flows, setFlows] = useState<Set<string> | "all">(defaults.flows && defaults.flows !== "all" ? new Set(defaults.flows) : "all");
  const [sources, setSources] = useState<Set<string> | "all">(defaults.sources && defaults.sources !== "all" ? new Set(defaults.sources) : "all");
  const [email, setEmail] = useState(!!defaults.email);
  const [to, setTo] = useState<Set<string>>(new Set(options.recipients));
  const [extra, setExtra] = useState("");
  const [attach, setAttach] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allCats = cats.size === options.categories.length;
  const scoped = options.categories.some((c) => c.scoped && cats.has(c.key));
  const relevantSources = useMemo(() => options.sources.filter((s) => s.categories.some((c) => cats.has(c))), [options.sources, cats]);
  const toggle = <T,>(set: Set<T>, v: T) => {
    const next = new Set(set);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    return next;
  };
  const extraList = extra.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const badExtra = extraList.filter((e) => !EMAIL.test(e));
  const recipients = [...new Set([...to, ...extraList.filter((e) => EMAIL.test(e))])];
  const field = "grid gap-1 text-sm font-medium text-fg";
  const box = "rounded-lg border border-line p-4";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!cats.size) return setError("Choose at least one category.");
    if (preset === "custom" && (!start || !end)) return setError("A custom range needs a start and an end date.");
    if (preset === "custom" && start > end) return setError("The start date is after the end date.");
    if (email && !recipients.length) return setError("Add at least one recipient, or untick Email the report.");
    if (email && badExtra.length) return setError(`Not an email address: ${badExtra.join(", ")}`);
    setBusy(true);
    try {
      const body = {
        ...(title.trim() ? { title: title.trim() } : {}),
        range: preset === "custom" ? { preset, start, end } : { preset },
        categories: [...cats],
        crews: crews === "all" || !scoped ? "all" : [...crews],
        flows: flows === "all" || !scoped ? "all" : [...flows],
        sources: sources === "all" ? "all" : [...sources],
        ...(email ? { email: { recipients, attach } } : {}),
      };
      const res = await fetch("/api/admin/crewai/reports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = (await res.json().catch(() => ({}))) as { id?: string; existing?: boolean; error?: string; issues?: string[] };
      if (!res.ok || !data.id) throw new Error([data.error ?? `HTTP ${res.status}`, ...(data.issues ?? [])].join(" "));
      router.push(`/admin/crewai/reports/${data.id}${data.existing ? "?existing=1" : ""}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const chips = (list: { key: string; label: string }[], value: Set<string> | "all", set: (v: Set<string> | "all") => void, name: string) => (
    <fieldset className="grid gap-2">
      <legend className="text-sm font-medium text-fg">{name}</legend>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value === "all"} onChange={(e) => set(e.target.checked ? "all" : new Set())} /> All {name.toLowerCase()}</label>
      {value !== "all" && (
        <div className="flex max-h-48 flex-wrap gap-2 overflow-y-auto">
          {list.length ? list.map((x) => (
            <label key={x.key} className={`inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-md border px-2 text-sm ${value.has(x.key) ? "border-accent bg-accent-soft text-fg" : "border-line text-fg-muted"}`}>
              <input type="checkbox" className="sr-only" checked={value.has(x.key)} onChange={() => set(toggle(value, x.key))} />
              {x.label}
            </label>
          )) : <span className="text-sm text-fg-subtle">None found on this site.</span>}
        </div>
      )}
    </fieldset>
  );

  return (
    <form onSubmit={submit} className="grid gap-5" aria-label="Generate a report">
      {!options.agentOn && <Alert tone="info">The SEO agent is off: the report will have every figure, finding and file except the AI analysis and the PDF, and will say so.</Alert>}
      {!options.storageReady && <Alert tone="info">Media storage (Cloudflare R2) is not configured: the report can be viewed here, but no file can be stored or downloaded until it is (Settings → Storage).</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <label className={field}>
          Title (optional)
          <input className={inputClass} value={title} maxLength={160} onChange={(e) => setTitle(e.target.value)} placeholder="Made from the categories and dates when empty" />
        </label>
        <label className={field}>
          Date range
          <select className={inputClass} value={preset} onChange={(e) => setPreset(e.target.value)}>
            {options.presets.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
        </label>
        {preset === "custom" && (
          <>
            <label className={field}>Start date<input type="date" className={inputClass} value={start} max={end || today} onChange={(e) => setStart(e.target.value)} required /></label>
            <label className={field}>End date<input type="date" className={inputClass} value={end} min={start || undefined} max={today} onChange={(e) => setEnd(e.target.value)} required /></label>
          </>
        )}
      </div>
      <p className="-mt-2 text-xs text-fg-subtle">Dates are in India Standard Time. Every figure is compared with the same number of days just before.</p>

      <fieldset className={box}>
        <legend className="px-1 text-sm font-semibold text-fg">Categories</legend>
        <div className="mb-3 flex flex-wrap gap-2">
          <Button type="button" size="sm" variant={allCats ? "primary" : "secondary"} onClick={() => setCats(new Set(options.categories.map((c) => c.key)))}>Site-wide (all categories)</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setCats(new Set())}>Clear</Button>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {options.categories.map((c) => (
            <label key={c.key} className="flex items-start gap-2 rounded-md p-1 text-sm hover:bg-surface-muted">
              <input type="checkbox" className="mt-1" checked={cats.has(c.key)} onChange={() => setCats(toggle(cats, c.key))} />
              <span><span className="font-medium text-fg">{c.label}</span><span className="block text-xs text-fg-subtle">{c.description}</span></span>
            </label>
          ))}
        </div>
      </fieldset>

      <details className={box} open={crews !== "all" || flows !== "all"}>
        <summary className="cursor-pointer text-sm font-semibold text-fg">Crews and flows {scoped ? "" : <span className="font-normal text-fg-subtle">(used by the CrewAI, LLM, reliability and agent categories)</span>}</summary>
        <div className={`mt-3 grid gap-4 ${scoped ? "" : "pointer-events-none opacity-50"}`} aria-disabled={!scoped}>
          {chips(options.crews, crews, setCrews, "Crews")}
          {chips(options.flows, flows, setFlows, "Flows")}
          <p className="text-xs text-fg-subtle">Choosing crews narrows the report to the flows that run them.</p>
        </div>
      </details>

      <details className={box} open={sources !== "all"}>
        <summary className="cursor-pointer text-sm font-semibold text-fg">Data sources <span className="font-normal text-fg-subtle">({relevantSources.filter((s) => s.status === "ok").length} of {relevantSources.length} available for these categories)</span></summary>
        <div className="mt-3 grid gap-2">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={sources === "all"} onChange={(e) => setSources(e.target.checked ? "all" : new Set(relevantSources.filter((s) => s.status !== "unavailable").map((s) => s.key)))} /> Every source</label>
          <ul className="grid gap-1">
            {relevantSources.map((s) => (
              <li key={s.key} className="flex flex-wrap items-center gap-2 text-sm">
                <input type="checkbox" aria-label={s.label} disabled={sources === "all"} checked={sources === "all" || sources.has(s.key)} onChange={() => sources !== "all" && setSources(toggle(sources, s.key))} />
                <span className="text-fg">{s.label}</span>
                <span className={`rounded px-1.5 py-0.5 text-xs ${STATUS[s.status]?.cls ?? STATUS.unavailable!.cls}`}>{STATUS[s.status]?.label ?? s.status}</span>
                {s.status !== "ok" && <span className="text-xs text-fg-subtle">{s.detail}</span>}
              </li>
            ))}
          </ul>
          <p className="text-xs text-fg-subtle">A source that is not available is reported in the report with the reason; it is never filled in.</p>
        </div>
      </details>

      <fieldset className={box}>
        <legend className="px-1 text-sm font-semibold text-fg">Email</legend>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={email} onChange={(e) => setEmail(e.target.checked)} disabled={!options.mailConfigured} /> Email the report when it is ready</label>
        {!options.mailConfigured && <p className="mt-1 text-xs text-fg-subtle">Email is not configured (Settings → Email).</p>}
        {email && (
          <div className="mt-3 grid gap-3">
            {options.recipients.length > 0 && (
              <div className="flex flex-wrap gap-3">
                {options.recipients.map((r) => <label key={r} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={to.has(r)} onChange={() => setTo(toggle(to, r))} /> {r}</label>)}
              </div>
            )}
            <label className={field}>Other recipients<input className={inputClass} value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="name@example.com, …" /></label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={attach} onChange={(e) => setAttach(e.target.checked)} /> Attach the PDF when it fits (otherwise a download link)</label>
          </div>
        )}
      </fieldset>

      {error && <Alert>{error}</Alert>}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={busy}>{email ? "Generate and email" : "Generate report"}</Button>
        <span className="text-xs text-fg-subtle">It runs in the background: you can leave this page.</span>
      </div>
    </form>
  );
}
