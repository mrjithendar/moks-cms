"use client";

import { useId, useState } from "react";
import type { JsonSchema } from "@/lib/seo-agent/client";

/**
 * A form for a flow's inputs, generated from the JSON Schema of its input model (the agent's GET /flows), like
 * Jenkins' "Build with Parameters": text, numbers, yes/no, choices and lists get their own controls; anything else
 * (objects, lists of objects) is edited as JSON. "Edit as JSON" shows the whole input object. An empty optional
 * field is left out, so the flow uses its default. The agent checks the result before the run starts.
 */

type Kind = { kind: "string" | "integer" | "number" | "boolean" | "enum" | "enum-list" | "string-list" | "json"; schema: JsonSchema; optional: boolean; options?: string[] };

function resolve(s: JsonSchema, required: boolean): Kind {
  let schema = s;
  let optional = !required;
  if (s.anyOf?.length) {
    const nonNull = s.anyOf.filter((x) => x.type !== "null");
    if (nonNull.length !== s.anyOf.length) optional = true;
    if (nonNull.length === 1) schema = { ...nonNull[0]!, description: s.description, default: s.default, title: s.title };
    else return { kind: "json", schema: s, optional };
  }
  if (schema.enum) return { kind: "enum", schema, optional, options: schema.enum.map(String) };
  if (schema.type === "boolean") return { kind: "boolean", schema, optional };
  if (schema.type === "integer" || schema.type === "number") return { kind: schema.type, schema, optional };
  if (schema.type === "string") return { kind: "string", schema, optional };
  if (schema.type === "array" && schema.items?.enum) return { kind: "enum-list", schema, optional, options: schema.items.enum.map(String) };
  if (schema.type === "array" && schema.items?.type === "string") return { kind: "string-list", schema, optional };
  return { kind: "json", schema, optional };
}

const label = (key: string, s: JsonSchema) => s.title && s.title.toLowerCase() !== key.replace(/_/g, " ") ? s.title : key.replace(/_/g, " ");

function hint(k: Kind): string {
  const s = k.schema;
  const parts: string[] = [];
  if (s.description) parts.push(s.description);
  if (s.minimum != null || s.maximum != null) parts.push(`${s.minimum ?? "…"} to ${s.maximum ?? "…"}`);
  if (s.maxLength) parts.push(`at most ${s.maxLength} characters`);
  if (s.pattern && /UUID|0-9a-fA-F]{8}/.test(s.pattern)) parts.push("an ID (UUID)");
  if (k.kind === "string-list") parts.push("one per line");
  if (s.default !== undefined && s.default !== null && !(Array.isArray(s.default) && s.default.length === 0)) parts.push(`default ${JSON.stringify(s.default)}`);
  return parts.join(" · ");
}

export function ParamsForm({ schema, value, onChange, idPrefix = "p" }: { schema: JsonSchema; value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void; idPrefix?: string }) {
  const uid = useId();
  const props = Object.entries(schema.properties ?? {});
  const required = new Set(schema.required ?? []);
  const [rawJson, setRawJson] = useState<Record<string, string>>({});
  const [jsonErr, setJsonErr] = useState<Record<string, string>>({});
  const set = (key: string, v: unknown) => {
    const next = { ...value };
    if (v === undefined || v === "" || (Array.isArray(v) && v.length === 0 && !required.has(key))) delete next[key];
    else next[key] = v;
    onChange(next);
  };
  if (props.length === 0) return <p className="text-sm text-fg-muted">This flow takes no parameters.</p>;
  return (
    <div className="space-y-4">
      {props.map(([key, s]) => {
        const k = resolve(s, required.has(key));
        const id = `${idPrefix}-${uid}-${key}`;
        const h = hint(k);
        const v = value[key];
        const head = (
          <label htmlFor={id} className="block text-sm font-medium text-fg">
            {label(key, s)} <code className="ml-1 text-xs font-normal text-fg-subtle">{key}</code>
            {k.optional ? <span className="font-normal text-fg-subtle"> (optional)</span> : <span className="font-normal text-red-700 dark:text-red-300"> (required)</span>}
          </label>
        );
        const help = h ? <p id={`${id}-hint`} className="text-xs text-fg-subtle">{h}</p> : null;
        const cls = "block w-full min-h-11 rounded-[var(--radius-control)] border border-line-strong bg-surface px-3 py-2 text-base text-fg sm:text-sm";
        switch (k.kind) {
          case "boolean":
            return (
              <div key={key} className="space-y-1">
                <label className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-fg">
                  <input id={id} type="checkbox" className="h-4 w-4" checked={v === undefined ? Boolean(k.schema.default) : Boolean(v)} onChange={(e) => set(key, e.target.checked)} aria-describedby={h ? `${id}-hint` : undefined} />
                  {label(key, s)} <code className="text-xs font-normal text-fg-subtle">{key}</code>
                </label>
                {help}
              </div>
            );
          case "enum":
            return (
              <div key={key} className="space-y-1">
                {head}
                <select id={id} className={cls} value={v === undefined ? "" : String(v)} onChange={(e) => set(key, e.target.value || undefined)} aria-describedby={h ? `${id}-hint` : undefined}>
                  <option value="">{k.schema.default !== undefined && k.schema.default !== null ? `Default (${String(k.schema.default)})` : "—"}</option>
                  {k.options!.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
                {help}
              </div>
            );
          case "enum-list": {
            const list = Array.isArray(v) ? (v as string[]) : [];
            return (
              <fieldset key={key} className="space-y-1">
                <legend className="text-sm font-medium text-fg">{label(key, s)} <code className="ml-1 text-xs font-normal text-fg-subtle">{key}</code></legend>
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {k.options!.map((o) => (
                    <label key={o} className="inline-flex min-h-9 items-center gap-2 text-sm text-fg">
                      <input type="checkbox" className="h-4 w-4" checked={list.includes(o)} onChange={(e) => set(key, e.target.checked ? [...list, o] : list.filter((x) => x !== o))} />
                      {o}
                    </label>
                  ))}
                </div>
                <p className="text-xs text-fg-subtle">{h || "None ticked: all of them."}</p>
              </fieldset>
            );
          }
          case "integer":
          case "number":
            return (
              <div key={key} className="space-y-1">
                {head}
                <input id={id} type="number" inputMode="numeric" className={cls} min={k.schema.minimum} max={k.schema.maximum} step={k.kind === "integer" ? 1 : "any"} value={v === undefined ? "" : String(v)} placeholder={k.schema.default != null ? String(k.schema.default) : undefined} onChange={(e) => set(key, e.target.value === "" ? undefined : Number(e.target.value))} aria-describedby={h ? `${id}-hint` : undefined} />
                {help}
              </div>
            );
          case "string":
            return (
              <div key={key} className="space-y-1">
                {head}
                <input id={id} type="text" className={`${cls} font-mono`} maxLength={k.schema.maxLength} value={v === undefined ? "" : String(v)} placeholder={typeof k.schema.default === "string" ? k.schema.default : undefined} onChange={(e) => set(key, e.target.value.trim() === "" ? undefined : e.target.value)} aria-describedby={h ? `${id}-hint` : undefined} spellCheck={false} />
                {help}
              </div>
            );
          case "string-list":
            return (
              <div key={key} className="space-y-1">
                {head}
                <textarea id={id} rows={3} className={`${cls} font-mono`} value={Array.isArray(v) ? (v as string[]).join("\n") : ""} onChange={(e) => set(key, e.target.value.split("\n").map((x) => x.trim()).filter(Boolean))} aria-describedby={h ? `${id}-hint` : undefined} spellCheck={false} />
                {help}
              </div>
            );
          default: {
            const text = rawJson[key] ?? (v === undefined ? "" : JSON.stringify(v, null, 2));
            return (
              <div key={key} className="space-y-1">
                {head}
                <textarea
                  id={id}
                  rows={4}
                  className={`${cls} font-mono`}
                  value={text}
                  spellCheck={false}
                  aria-invalid={jsonErr[key] ? true : undefined}
                  aria-describedby={`${id}-hint`}
                  onChange={(e) => {
                    const t = e.target.value;
                    setRawJson((r) => ({ ...r, [key]: t }));
                    if (t.trim() === "") {
                      setJsonErr((r) => ({ ...r, [key]: "" }));
                      set(key, undefined);
                      return;
                    }
                    try {
                      set(key, JSON.parse(t));
                      setJsonErr((r) => ({ ...r, [key]: "" }));
                    } catch {
                      setJsonErr((r) => ({ ...r, [key]: "Not valid JSON yet." }));
                    }
                  }}
                />
                <p id={`${id}-hint`} className={`text-xs ${jsonErr[key] ? "text-red-700 dark:text-red-300" : "text-fg-subtle"}`}>{jsonErr[key] || h || "JSON."}</p>
              </div>
            );
          }
        }
      })}
    </div>
  );
}
