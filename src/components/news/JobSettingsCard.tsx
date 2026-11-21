"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Card } from "@/components/admin/ui";
import { useUnsavedChanges } from "@/components/admin/SettingsSections";
import { Alert, Button, Input, Select, Textarea } from "@/components/ui/form";
import { groupValues, JOB_SETTING_GROUPS, type JobSettingGroupId, type SettingField } from "@/lib/news/settings-fields";
import { api } from "./api";
import { Field } from "./Fld";

type Values = Record<string, unknown> & { quality?: Record<string, unknown> };

/**
 * One group of the crew jobs' shared settings (lib/news/settings-fields.ts), on the page that owns its subject. Saves
 * only its own fields: PUT /api/admin/news/settings merges them into the row (audit-logged as before).
 */
export function JobSettingsCard({ group: id, initial, hints = {} }: { group: JobSettingGroupId; initial: Record<string, unknown>; hints?: Record<string, string> }) {
  const group = JOB_SETTING_GROUPS[id];
  const router = useRouter();
  const start = useMemo(() => groupValues(group, initial) as Values, [group, initial]);
  const [v, setV] = useState<Values>(start);
  const [saved, setSaved] = useState<Values>(start);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const dirty = JSON.stringify(v) !== JSON.stringify(saved);
  useUnsavedChanges(dirty);

  const get = (f: SettingField) => (f.kind === "number" && f.quality ? v.quality?.[f.key] : v[f.key]);
  const put = (f: SettingField, value: unknown) => setV((x) => (f.kind === "number" && f.quality ? { ...x, quality: { ...x.quality, [f.key]: value } } : { ...x, [f.key]: value }));

  const control = (f: SettingField) => {
    const value = get(f);
    switch (f.kind) {
      case "number":
        return <Input type="number" step={f.step ?? 1} value={Number(value ?? 0)} onChange={(e) => put(f, Number(e.target.value))} />;
      case "text":
        return <Input value={String(value ?? "")} onChange={(e) => put(f, e.target.value)} />;
      case "lines":
        return <Textarea rows={3} value={((value as string[] | undefined) ?? []).join("\n")} onChange={(e) => put(f, e.target.value.split("\n").map((x) => x.trim().toLowerCase()).filter(Boolean))} />;
      case "select":
        return (
          <Select value={String(value ?? "")} onChange={(e) => put(f, e.target.value)}>
            {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
        );
    }
  };

  return (
    <Card className="mt-6">
      <h2 id={`job-settings-${id}`} className="scroll-mt-24 text-sm font-semibold text-fg">{group.title}</h2>
      <p className="mt-1 text-sm text-fg-muted">{group.description}</p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {group.fields.map((f) => (
          <div key={f.key} className={f.kind === "lines" ? "sm:col-span-2 lg:col-span-3" : undefined}>
            <Field label={f.label} hint={hints[f.key] ?? f.hint}>{control(f)}</Field>
          </div>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          disabled={busy || !dirty}
          onClick={async () => {
            setBusy(true);
            try {
              await api("/api/admin/news/settings", "PUT", v);
              setSaved(v);
              setMsg({ ok: true, text: "Saved." });
              router.refresh();
            } catch (e) {
              setMsg({ ok: false, text: (e as Error).message });
            } finally {
              setBusy(false);
            }
          }}
        >
          Save {group.title.toLowerCase()}
        </Button>
        {dirty && <span className="text-xs text-fg-subtle">Not saved yet.</span>}
      </div>
      {msg && <div className="mt-3"><Alert tone={msg.ok ? "success" : "error"}>{msg.text}</Alert></div>}
    </Card>
  );
}
