"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/form";

type Settings = {
  enabled: boolean;
  channels: Record<string, boolean>;
  subreddits: string[];
  redditMinScore: number;
  utmMedium: string;
  utmCampaign: string;
  articlesPerRun: number;
  ideasPerRun: number;
  minScore: number;
};

/** Promotion settings: channels, subreddits, link tags and limits. Saved as one document (PUT, audit-logged). */
export function PromotionSettingsForm({ settings, channels }: { settings: Settings; channels: { id: string; label: string }[] }) {
  const router = useRouter();
  const [s, setS] = useState<Settings>(settings);
  const [subs, setSubs] = useState(settings.subreddits.join(", "));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const input = "min-h-9 w-full rounded-md border border-line-strong bg-surface px-2 text-sm text-fg";
  const num = (key: "redditMinScore" | "articlesPerRun" | "ideasPerRun" | "minScore", label: string, min: number, max: number) => (
    <label className="grid gap-1 text-xs text-fg-subtle">
      {label}
      <input type="number" min={min} max={max} className={input} value={s[key]} onChange={(e) => setS({ ...s, [key]: Number(e.target.value) })} />
    </label>
  );
  return (
    <form
      className="grid gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setMsg(null);
        try {
          const subreddits = subs.split(/[\s,]+/).map((x) => x.replace(/^\/?r\//i, "").trim()).filter(Boolean);
          const res = await fetch("/api/admin/seo/promotion/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...s, subreddits }) });
          const data = (await res.json().catch(() => ({}))) as { error?: string; issues?: string[] };
          if (!res.ok) setMsg({ ok: false, text: [data.error ?? `HTTP ${res.status}`, ...(data.issues ?? [])].join(" ") });
          else {
            setMsg({ ok: true, text: "Saved." });
            router.refresh();
          }
        } catch {
          setMsg({ ok: false, text: "Network error." });
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="flex items-center gap-2 text-sm text-fg">
        <input type="checkbox" checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} />
        Promotion is on (opportunities, drafted posts and content ideas)
      </label>
      <fieldset className="grid gap-2">
        <legend className="text-xs font-semibold text-fg-subtle">Channels</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {channels.map((c) => (
            <label key={c.id} className="flex items-center gap-2 text-sm text-fg">
              <input type="checkbox" checked={Boolean(s.channels[c.id])} onChange={(e) => setS({ ...s, channels: { ...s.channels, [c.id]: e.target.checked } })} />
              {c.label}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="grid gap-1 text-xs text-fg-subtle">
        Subreddits to read (names without r/, separated by commas; at most 15)
        <textarea className={`${input} min-h-16 py-2`} value={subs} onChange={(e) => setSubs(e.target.value)} />
      </label>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {num("redditMinScore", "Minimum upvotes for a thread", 0, 100000)}
        {num("minScore", "Draft posts for channels scoring at least", 0, 100)}
        {num("articlesPerRun", "New articles per scheduled run", 1, 10)}
        {num("ideasPerRun", "Content ideas per weekly run", 1, 15)}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-xs text-fg-subtle">
          utm_medium on tagged links
          <input className={input} value={s.utmMedium} pattern="[a-z0-9_-]{1,40}" onChange={(e) => setS({ ...s, utmMedium: e.target.value })} />
        </label>
        <label className="grid gap-1 text-xs text-fg-subtle">
          utm_campaign on tagged links
          <input className={input} value={s.utmCampaign} pattern="[a-z0-9_-]{1,40}" onChange={(e) => setS({ ...s, utmCampaign: e.target.value })} />
        </label>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" loading={busy}>Save settings</Button>
        {msg && <span role="status" className={`text-xs ${msg.ok ? "text-emerald-700 dark:text-emerald-300" : "text-red-700 dark:text-red-300"}`}>{msg.text}</span>}
      </div>
    </form>
  );
}
