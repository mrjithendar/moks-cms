"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useUnsavedChanges } from "@/components/admin/SettingsSections";
import { Card } from "@/components/admin/ui";
import { Alert, Button } from "@/components/ui/form";
import type { PublicSeoSettings } from "@/lib/seo-intel/settings";
import { changedPaths, FIELD_HELP, getIn, issuesByPath, type Json, SECTION_LABELS, SETTINGS_TABS, tabOf } from "@/lib/seo-intel/settings-meta";

/**
 * Settings editor generated from the settings document, grouped into tabs (settings-meta.ts): booleans → checkboxes,
 * numbers → number inputs, strings → text, string lists → comma-separated text (search types → checkboxes).
 * Every field shows when it differs from the saved value ("changed") and from the default; validation issues from the
 * server land on their field and on their tab. The server validates everything.
 */
function subscribeHash(cb: () => void) {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
}

const SEARCH_TYPES = ["web", "image", "video", "news", "discover", "googleNews"];

const human = (k: string) => k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
const show = (v: Json | undefined) => (Array.isArray(v) ? v.join(", ") || "none" : v === "" || v === null || v === undefined ? "empty" : String(v));

function setIn(obj: Json, path: string[], value: Json): Json {
  if (!path.length) return value;
  const [h, ...rest] = path;
  const o = (obj && typeof obj === "object" && !Array.isArray(obj) ? obj : {}) as Record<string, Json>;
  return { ...o, [h!]: setIn(o[h!] ?? null, rest, value) };
}

/**
 * What a save sends: the whole document, or (for one area on its own) only that area's sections with their names in
 * `only`, which the server lays over the stored document.
 */
export function saveBody(value: Json, sections: string[] | null): Record<string, unknown> {
  const doc = value as Record<string, Json>;
  if (!sections) return { ...doc };
  return { ...Object.fromEntries(sections.filter((s) => s in doc).map((s) => [s, doc[s]])), only: sections };
}

type Ctx = { changed: Set<string>; defaults: Json; issues: Record<string, string[]>; onChange: (path: string[], v: Json) => void };

function Meta({ dotted, value, ctx }: { dotted: string; value: Json; ctx: Ctx }) {
  const help = FIELD_HELP[dotted];
  const def = getIn(ctx.defaults, dotted);
  const differs = def !== undefined && JSON.stringify(def) !== JSON.stringify(value);
  const errs = ctx.issues[dotted];
  return (
    <>
      {help && <span className="text-[11px] leading-snug text-fg-subtle">{help}</span>}
      {differs && <span className="text-[11px] text-fg-subtle">Default: {show(def)}</span>}
      {errs?.map((e) => (
        <span key={e} id={`seo-${dotted.replaceAll(".", "-")}-err`} className="text-[11px] font-medium text-red-700 dark:text-red-300">
          {e}
        </span>
      ))}
    </>
  );
}

function ChangedDot({ on }: { on: boolean }) {
  return on ? <span title="Changed, not saved yet" aria-label="changed, not saved" className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-amber-500 align-middle" /> : null;
}

function Field({ path, value, ctx }: { path: string[]; value: Json; ctx: Ctx }) {
  const key = path.at(-1)!;
  const dotted = path.join(".");
  const id = `seo-${path.join("-")}`;
  const invalid = Boolean(ctx.issues[dotted]?.length);
  const changed = ctx.changed.has(dotted);
  const input = `min-h-9 w-full rounded-md border bg-surface px-2 text-sm text-fg ${invalid ? "border-red-500" : changed ? "border-amber-500" : "border-line-strong"}`;
  const aria = { "aria-invalid": invalid || undefined, "aria-describedby": invalid ? `${id}-err` : undefined };
  if (typeof value === "boolean")
    return (
      <div className="grid gap-0.5">
        <label htmlFor={id} className="flex items-center gap-2 text-sm text-fg">
          <input id={id} type="checkbox" checked={value} onChange={(e) => ctx.onChange(path, e.target.checked)} {...aria} /> {human(key)}
          <ChangedDot on={changed} />
        </label>
        <Meta dotted={dotted} value={value} ctx={ctx} />
      </div>
    );
  if (key === "searchTypes" && Array.isArray(value))
    return (
      <fieldset className="grid gap-0.5 text-sm">
        <legend className="text-xs text-fg-subtle">
          Search types <ChangedDot on={changed} />
        </legend>
        <div className="mt-1 flex flex-wrap gap-3">
          {SEARCH_TYPES.map((t) => (
            <label key={t} className="flex items-center gap-1">
              <input type="checkbox" checked={value.includes(t)} onChange={(e) => ctx.onChange(path, e.target.checked ? [...value, t] : value.filter((v) => v !== t))} /> {t}
            </label>
          ))}
        </div>
        <Meta dotted={dotted} value={value} ctx={ctx} />
      </fieldset>
    );
  if (Array.isArray(value))
    return (
      <label htmlFor={id} className="grid gap-1 text-xs text-fg-subtle">
        <span>
          {human(key)} (comma-separated) <ChangedDot on={changed} />
        </span>
        <input id={id} className={input} value={value.join(", ")} onChange={(e) => ctx.onChange(path, e.target.value.split(",").map((s) => s.trim()).filter(Boolean))} {...aria} />
        <Meta dotted={dotted} value={value} ctx={ctx} />
      </label>
    );
  if (value && typeof value === "object")
    return (
      <fieldset className="rounded-lg border border-line p-3 sm:col-span-2">
        <legend className="px-1 text-xs font-semibold text-fg-muted">{human(key)}</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {Object.entries(value).map(([k, v]) => (
            <Field key={k} path={[...path, k]} value={v} ctx={ctx} />
          ))}
        </div>
      </fieldset>
    );
  return (
    <label htmlFor={id} className="grid gap-1 text-xs text-fg-subtle">
      <span>
        {human(key)} <ChangedDot on={changed} />
      </span>
      <input
        id={id}
        className={input}
        type={typeof value === "number" ? "number" : "text"}
        step="any"
        value={value === null ? "" : String(value)}
        onChange={(e) => ctx.onChange(path, typeof value === "number" ? (e.target.value === "" ? 0 : Number(e.target.value)) : e.target.value)}
        {...aria}
      />
      <Meta dotted={dotted} value={value} ctx={ctx} />
    </label>
  );
}

/**
 * `only`: one area (a tab id from settings-meta.ts) on its own, as a section of AI & SEO settings. It shows that area
 * without the tab strip and saves just that area's sections: the server lays them over the stored document, so two
 * admins working in different areas do not overwrite each other.
 */
export function SettingsForm({ initial, defaults, only }: { initial: PublicSeoSettings; defaults?: PublicSeoSettings; only?: string }) {
  const router = useRouter();
  const saved = initial as unknown as Json;
  const defaultsJson = useMemo(() => (defaults ?? {}) as unknown as Json, [defaults]);
  const [value, setValue] = useState<Json>(saved);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string; issues?: string[] } | null>(null);
  const sections = Object.keys(value as Record<string, Json>);
  const tabs = useMemo(() => {
    const known = SETTINGS_TABS.map((t) => ({ ...t, sections: t.sections.filter((s) => sections.includes(s)) })).filter((t) => t.sections.length);
    const other = sections.filter((s) => tabOf(s) === "other");
    const all = other.length ? [...known, { id: "other", label: "Other", sections: other, description: "" }] : known;
    return only ? all.filter((t) => t.id === only) : all;
  }, [sections, only]);
  // The open tab: the one clicked, else #tab-<id> from the URL (shareable link), else the first.
  const hashTab = useSyncExternalStore(subscribeHash, () => window.location.hash.replace(/^#tab-/, ""), () => "");
  const [picked, setPicked] = useState<string | null>(null);
  const tab = only ?? picked ?? (tabs.some((t) => t.id === hashTab) ? hashTab : (tabs[0]?.id ?? "data"));

  const changed = useMemo(() => new Set(changedPaths(saved, value)), [saved, value]);
  const dirty = changed.size > 0;
  useUnsavedChanges(dirty);
  const issues = useMemo(() => issuesByPath(result?.ok === false ? (result.issues ?? []) : []), [result]);
  const countIn = (t: { sections: string[] }, paths: Iterable<string>) => [...paths].filter((p) => t.sections.includes(p.split(".")[0]!)).length;
  const unplaced = Object.entries(issues).filter(([p]) => !p || !sections.includes(p.split(".")[0]!)).flatMap(([p, m]) => m.map((x) => (p ? `${p}: ${x}` : x)));

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const ctx: Ctx = { changed, defaults: defaultsJson, issues, onChange: (path, v) => setValue((cur) => setIn(cur, path, v)) };
  const choose = (id: string) => {
    setPicked(id);
    window.history.replaceState(null, "", `#tab-${id}`);
  };
  const active = tabs.find((t) => t.id === tab) ?? tabs[0];

  return (
    <form
      className="space-y-4 pb-24"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setResult(null);
        const res = await fetch("/api/admin/seo/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(saveBody(value, only ? (tabs[0]?.sections ?? []) : null)) }).catch(() => null);
        const data = (await res?.json().catch(() => ({}))) as { error?: string; issues?: string[] } | undefined;
        setBusy(false);
        if (res?.ok) {
          setResult({ ok: true, text: "Saved." });
          router.refresh();
        } else {
          setResult({ ok: false, text: data?.error ?? "Could not save.", issues: data?.issues });
          const first = (data?.issues ?? []).map((i) => i.split(".")[0]!).find((s) => sections.includes(s));
          if (first && !only) choose(tabOf(first) === "other" ? "other" : tabOf(first));
        }
      }}
    >
      {!only && (
        <div role="tablist" aria-label="Settings sections" className="flex flex-wrap gap-1 border-b border-line">
          {tabs.map((t) => {
            const nChanged = countIn(t, changed);
            const nIssues = countIn(t, Object.keys(issues));
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`tab-${t.id}`}
                aria-selected={t.id === active?.id}
                aria-controls={`panel-${t.id}`}
                onClick={() => choose(t.id)}
                className={`-mb-px rounded-t-md border-b-2 px-3 py-2 text-sm ${t.id === active?.id ? "border-accent font-semibold text-fg" : "border-transparent text-fg-muted hover:text-fg"}`}
              >
                {t.label}
                {nIssues > 0 && <span className="ml-1.5 rounded-full bg-red-600 px-1.5 text-[10px] font-semibold text-white">{nIssues}</span>}
                {nIssues === 0 && nChanged > 0 && <span className="ml-1.5 rounded-full bg-amber-500 px-1.5 text-[10px] font-semibold text-white" aria-label={`${nChanged} unsaved`}>{nChanged}</span>}
              </button>
            );
          })}
        </div>
      )}

      {active && (
        <div role={only ? undefined : "tabpanel"} id={`panel-${active.id}`} aria-labelledby={only ? undefined : `tab-${active.id}`} className="space-y-4">
          {active.description && <p className="text-sm text-fg-muted">{active.description}</p>}
          {active.sections.map((section) => (
            <Card key={section}>
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="font-semibold text-fg">{SECTION_LABELS[section] ?? human(section)}</h2>
                {countIn({ sections: [section] }, changed) > 0 && (
                  <button type="button" className="text-xs text-accent-text underline" onClick={() => setValue((cur) => setIn(cur, [section], (saved as Record<string, Json>)[section] ?? null))}>
                    Undo changes in this section
                  </button>
                )}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {Object.entries((value as Record<string, Json>)[section] as Record<string, Json>).map(([k, leaf]) => (
                  <Field key={k} path={[section, k]} value={leaf} ctx={ctx} />
                ))}
              </div>
            </Card>
          ))}
        </div>
      )}

      {result && (
        <Alert tone={result.ok ? "success" : "error"}>
          {result.text}
          {!result.ok && result.issues && result.issues.length > unplaced.length && <span> The fields with problems are marked in red.</span>}
          {unplaced.length > 0 && (
            <ul className="mt-1 list-disc pl-5">
              {unplaced.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          )}
        </Alert>
      )}

      <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface/95 px-4 py-3 shadow-sm backdrop-blur">
        <p className="text-sm text-fg-muted" aria-live="polite">
          {dirty ? `${changed.size} unsaved change${changed.size === 1 ? "" : "s"}` : "All changes saved"}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            disabled={!dirty || busy}
            onClick={() => {
              setValue(saved);
              setResult(null);
            }}
          >
            Discard
          </Button>
          <Button type="submit" loading={busy} disabled={!dirty}>
            Save settings
          </Button>
        </div>
      </div>
    </form>
  );
}
