"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useUnsavedChanges } from "@/components/admin/SettingsSections";
import { Card } from "@/components/admin/ui";
import { Alert, Button, Field, Input, Select, Textarea } from "@/components/ui/form";
import type { AgentSettingField, AgentSettingsGroup as Group, AgentSettingValue, AgentSettingsView } from "@/lib/seo-agent/client";
import type { AgentSettingsLoad } from "@/lib/seo-agent/settings-client";

type Drafts = Record<string, string>;

const SOURCE: Record<AgentSettingField["source"], string> = { admin: "Admin", deployment: "Deployment", default: "Default" };

/** A value as an admin reads and types it: a list one entry per line, a switch as on / off. */
export function shownValue(f: AgentSettingField, v: AgentSettingValue | undefined): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.join("\n");
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

/**
 * What a field's input starts with: the admin's saved value, or empty when nothing is saved here (the deployment's
 * value or the default applies, and is shown beside the field). A secret always starts empty: it is never sent back.
 */
export function draftOf(f: AgentSettingField): string {
  return f.type === "secret" || f.source !== "admin" ? "" : shownValue(f, f.value);
}

export const draftsOf = (g: Group): Drafts => Object.fromEntries(g.fields.map((f) => [f.env, draftOf(f)]));

/**
 * The body of a save: only the fields that changed. An emptied field is sent as null, which clears it in the agent
 * (the deployment's value, then the default, applies again). A number that is not one is reported here; every other
 * rule is the agent's.
 */
export function changesOf(g: Group, drafts: Drafts, clearSecrets: string[] = []): { values: Record<string, AgentSettingValue>; issues: string[] } {
  const values: Record<string, AgentSettingValue> = {};
  const issues: string[] = [];
  for (const f of g.fields) {
    const now = (drafts[f.env] ?? "").trim();
    if (f.type === "secret") {
      if (now) values[f.env] = now;
      else if (clearSecrets.includes(f.env) && f.set) values[f.env] = null;
      continue;
    }
    if (now === draftOf(f).trim()) continue;
    if (now === "") values[f.env] = null;
    else if (f.type === "integer" || f.type === "number") {
      const n = Number(now);
      if (!Number.isFinite(n)) issues.push(`${f.label}: enter a number`);
      else values[f.env] = n;
    } else if (f.type === "boolean") values[f.env] = now === "true";
    else if (f.type === "list") values[f.env] = now.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
    else values[f.env] = now;
  }
  return { values, issues };
}

/** "20 requests per minute", "on", "45 entries": the value that applies when the admin's field is empty. */
export function inEffect(f: AgentSettingField): string {
  if (f.type === "secret") return f.deployment_set ? "set by the deployment" : "not set";
  const v = f.source === "admin" ? (f.deployment ?? f.default) : f.value;
  if (Array.isArray(v)) return `${v.length} ${v.length === 1 ? "entry" : "entries"}`;
  if (typeof v === "boolean") return v ? "on" : "off";
  if (v === null || v === undefined || v === "") return "empty";
  return f.unit ? `${v} ${f.unit}` : String(v);
}

function range(f: AgentSettingField): string {
  if (f.min === null && f.max === null) return "";
  const unit = f.unit ? ` ${f.unit}` : "";
  if (f.min !== null && f.max !== null) return ` Allowed: ${f.min} to ${f.max}${unit}.`;
  return f.min !== null ? ` At least ${f.min}${unit}.` : ` At most ${f.max}${unit}.`;
}

function Chip({ children, tone = "plain" }: { children: string; tone?: "plain" | "warn" }) {
  const tones = tone === "warn" ? "bg-amber-50 text-amber-900 ring-amber-600/30 dark:bg-amber-500/10 dark:text-amber-200" : "bg-surface-sunken text-fg-muted ring-line";
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${tones}`}>{children}</span>;
}

/**
 * One group of an agent's own settings (the seo-agent's, or the news agent's with `agent`), drawn from the schema the
 * agent sends (its registry decides the fields, labels, units and ranges; app/admin_settings in each agent). This card only reads and writes the agent's
 * API: it keeps no value, and when the agent cannot be reached or is too old it says so and shows nothing editable.
 */
/** Which agent keeps the settings (both run the same settings store: moks-seo-agent and mrjithendar/newsroom). */
export type SettingsAgent = { name: string; endpoint: string; keyEnv: string };
export const SEO_AGENT_SETTINGS: SettingsAgent = { name: "SEO agent", endpoint: "/api/admin/seo/agent-settings", keyEnv: "SEO_AGENT_SETTINGS_KEY" };
export const NEWS_AGENT_SETTINGS: SettingsAgent = { name: "news agent", endpoint: "/api/admin/news/agent-settings", keyEnv: "NEWS_AGENT_SETTINGS_KEY" };

export function AgentSettingsGroup({ load, groupId, title, agent = SEO_AGENT_SETTINGS }: { load: AgentSettingsLoad; groupId: string; title: string; agent?: SettingsAgent }) {
  const router = useRouter();
  const [view, setView] = useState<AgentSettingsView | null>(load.view);
  const group = useMemo(() => view?.groups.find((g) => g.id === groupId) ?? null, [view, groupId]);
  const [drafts, setDrafts] = useState<Drafts>(() => (group ? draftsOf(group) : {}));
  const [clearSecrets, setClearSecrets] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; issues?: string[] } | null>(null);
  const anchor = `agent-settings-${groupId}`;
  const pending = useMemo(() => (group ? changesOf(group, drafts, clearSecrets) : null), [group, drafts, clearSecrets]);
  useUnsavedChanges(Boolean(pending && (Object.keys(pending.values).length > 0 || pending.issues.length > 0)));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!group) return;
    const { values, issues } = changesOf(group, drafts, clearSecrets);
    if (issues.length) {
      setMsg({ ok: false, text: "Some values are not valid.", issues });
      return;
    }
    if (Object.keys(values).length === 0) {
      setMsg({ ok: true, text: "Nothing changed." });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`${agent.endpoint}/${encodeURIComponent(groupId)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ values }) });
      const body = (await res.json().catch(() => ({}))) as { error?: string; issues?: string[]; reference?: string; view?: AgentSettingsView };
      if (!res.ok) setMsg({ ok: false, text: (body.error ?? `HTTP ${res.status}`) + (body.reference ? ` (ref ${body.reference})` : ""), issues: body.issues });
      else {
        const next = body.view?.groups.find((g) => g.id === groupId);
        if (body.view && next) {
          setView(body.view);
          setDrafts(draftsOf(next));
          setClearSecrets([]);
        }
        setMsg({ ok: true, text: next?.restart_pending ? `Saved in the ${agent.name}. Some of it applies after the agent restarts.` : `Saved in the ${agent.name}. It applies now.` });
        router.refresh();
      }
    } catch {
      setMsg({ ok: false, text: "Network error." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-6">
      <h2 id={anchor} className="scroll-mt-24 text-lg font-semibold text-fg">{group?.title ?? title}</h2>
      {group ? (
        <>
          <p className="mt-1 text-sm text-fg-muted">
            {group.description} These belong to the {agent.name}. A value saved here wins over the deployment&apos;s; an empty field uses the deployment&apos;s value, or the default when there is none.
          </p>
          {group.restart_pending && (
            <div className="mt-4">
              <Alert tone="info">A saved value is waiting for a restart of the {agent.name}. Until then the agent runs with the earlier one.</Alert>
            </div>
          )}
          <form onSubmit={save} className="mt-4 space-y-5">
            <div className="grid gap-5 lg:grid-cols-2">
              {group.fields.map((f) => {
                const id = `${anchor}-${f.env}`;
                const set = (v: string) => setDrafts((d) => ({ ...d, [f.env]: v }));
                const now = drafts[f.env] ?? "";
                const hint = (
                  <>
                    {f.hint}
                    {range(f)} {f.source === "admin" ? "Without a value here" : "In effect now"}: {inEffect(f)}. <code className="text-xs">{f.env}</code>
                  </>
                );
                return (
                  <div key={f.env} className={f.type === "list" ? "lg:col-span-2" : undefined}>
                    <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                      <Chip>{SOURCE[f.source]}</Chip>
                      <Chip>{f.apply === "live" ? "Applies now" : "Applies after restart"}</Chip>
                      {f.restart_pending && <Chip tone="warn">Restart pending</Chip>}
                    </div>
                    <Field label={f.unit ? `${f.label} (${f.unit})` : f.label} htmlFor={id} hint={hint}>
                      {f.type === "boolean" || f.type === "select" ? (
                        <Select id={id} value={now} onChange={(e) => set(e.target.value)} aria-describedby={`${id}-hint`}>
                          <option value="">Use the {f.source === "admin" ? "deployment's value or the default" : SOURCE[f.source].toLowerCase()}</option>
                          {f.type === "boolean" ? (
                            <>
                              <option value="true">On</option>
                              <option value="false">Off</option>
                            </>
                          ) : (
                            f.options.map((o) => <option key={o} value={o}>{o}</option>)
                          )}
                        </Select>
                      ) : f.type === "list" ? (
                        <Textarea id={id} rows={Math.min(12, Math.max(3, now.split("\n").length + 1))} value={now} onChange={(e) => set(e.target.value)} placeholder="One per line" spellCheck={false} aria-describedby={`${id}-hint`} />
                      ) : f.type === "secret" ? (
                        <Input id={id} type="password" autoComplete="off" value={now} onChange={(e) => set(e.target.value)} disabled={f.editable === false} placeholder={f.set ? "Saved. Type to replace it" : "Not set"} aria-describedby={`${id}-hint`} />
                      ) : (
                        <Input
                          id={id}
                          type={f.type === "text" ? "text" : "number"}
                          inputMode={f.type === "integer" ? "numeric" : f.type === "number" ? "decimal" : undefined}
                          step={f.type === "number" ? "any" : undefined}
                          min={f.type === "text" ? undefined : (f.min ?? undefined)}
                          max={f.type === "text" ? undefined : (f.max ?? undefined)}
                          value={now}
                          onChange={(e) => set(e.target.value)}
                          placeholder={shownValue(f, f.source === "admin" ? (f.deployment ?? f.default) : f.value)}
                          aria-describedby={`${id}-hint`}
                        />
                      )}
                    </Field>
                    {f.type === "secret" && f.editable === false && <p className="mt-1 text-sm text-fg-subtle">Requires manual configuration: the {agent.name} has no settings key ({agent.keyEnv}), so it cannot store a secret.</p>}
                    {f.type === "secret" && f.set && f.editable !== false && (
                      <label className="mt-2 flex items-center gap-2 text-sm text-fg-muted">
                        <input type="checkbox" checked={clearSecrets.includes(f.env)} onChange={(e) => setClearSecrets((c) => (e.target.checked ? [...c, f.env] : c.filter((k) => k !== f.env)))} />
                        Remove the saved secret
                      </label>
                    )}
                    {f.type !== "secret" && f.source === "admin" && now !== "" && (
                      <button type="button" className="mt-1.5 text-sm font-medium text-fg-muted underline" onClick={() => set("")}>
                        Use the deployment&apos;s value or the default ({inEffect(f)})
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            {msg && (
              <Alert tone={msg.ok ? "success" : "error"}>
                {msg.text}
                {msg.issues && msg.issues.length > 0 && (
                  <ul className="mt-1 list-disc pl-5">
                    {msg.issues.map((i) => <li key={i}>{i}</li>)}
                  </ul>
                )}
              </Alert>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={busy}>{busy ? "Saving…" : `Save ${group.title.toLowerCase()}`}</Button>
              <span className="text-sm text-fg-subtle">Checked and stored by the {agent.name}. Every save is in the audit log.</span>
            </div>
          </form>
        </>
      ) : (
        <div className="mt-4">
          <Alert tone={load.tooOld || view ? "info" : "error"}>
            {view ? `This needs a newer ${agent.name}: the one running does not have these settings yet.` : (load.error ?? `The ${agent.name} could not be asked.`)} These settings are kept by the {agent.name}, so they can be seen and changed only while
            it is reachable.
          </Alert>
        </div>
      )}
    </Card>
  );
}
