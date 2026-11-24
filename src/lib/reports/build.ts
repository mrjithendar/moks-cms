import "server-only";
import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { log } from "../log";
import { CATEGORIES, discoverSources, sourceOf } from "./catalog";
import { BUILDERS, family, type Ctx, type DraftFinding, type Part } from "./collect";
import { fmt, signedPct } from "./format";
import { bounds } from "./ranges";
import { REPORT_SCHEMA, SEVERITIES, type CategoryBlock, type Fact, type Finding, type Kpi, type ReportRange, type ReportScope, type SiteReport, type SourceStatus, type Untrusted } from "./types";

/**
 * Build a report's data (D-102): each chosen category's figures, charts, tables and findings; every source's status;
 * the facts the AI analysis may cite (formatted the way they must be written) and the system text it may quote (as
 * untrusted evidence). A category that fails is reported as unavailable with the error; the others still run.
 */
export type BuildInput = { id: string; title: string; range: ReportRange; scope: ReportScope; site: SiteReport["site"]; tenant: string; now?: Date };

const MAX_FACTS = 400;
const MAX_UNTRUSTED = 40;

/** Secrets have no place in a report: tokens, keys and credentials in error text are masked before anything stores it. */
export function redactText(text: string): string {
  return text
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
    .replace(/(authorization)(["'\s:=]+)(?!bearer|basic)[^\s"',;]+/gi, "$1$2[redacted]")
    .replace(/(api[_-]?key|token|secret|password|passwd)(["'\s:=]+)[^\s"',;]+/gi, "$1$2[redacted]")
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{12,}|ghp_[A-Za-z0-9]{20,}|xox[abp]-[A-Za-z0-9-]{10,})\b/g, "[redacted]")
    .replace(/:\/\/[^/\s:@]+:[^/\s@]+@/g, "://[redacted]@")
    .replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g, "[redacted]");
}

export async function buildReport(db: Db, input: BuildInput, deps: { crewOfFamily?: Map<string, string> } = {}): Promise<SiteReport> {
  const counters = { M: 0, C: 0, T: 0 };
  const untrusted: Untrusted[] = [];
  const { range, scope } = input;
  // The crews chosen narrow the report to the flows that run them (with the flows chosen, to both).
  let flows: string[] | null = scope.flows === "all" ? null : [...scope.flows];
  let families: string[] | null = null;
  if (scope.crews !== "all") {
    const crewFlows = rowsOf<{ flow_name: string }>(await db.execute(sql`select distinct flow_name from crewai_flows where deleted_at is null and crews && ${`{${scope.crews.map((c) => `"${c.replace(/["\\]/g, "")}"`).join(",")}}`}::text[]`));
    const set = new Set(crewFlows.map((f) => f.flow_name));
    flows = flows ? flows.filter((f) => set.has(f)) : [...set];
    families = [...(deps.crewOfFamily ?? new Map<string, string>()).entries()].filter(([, crew]) => scope.crews !== "all" && scope.crews.includes(crew.split(" · ")[1] ?? crew)).map(([fam]) => fam);
    if (!families.length) families = null;
  }
  const ctx: Ctx = {
    db,
    range,
    cur: bounds(range.start, range.end),
    prev: bounds(range.previousStart, range.previousEnd),
    flows,
    families,
    crewOfFamily: new Map([...(deps.crewOfFamily ?? new Map<string, string>()).entries()].map(([f, label]) => [f, label.split(" · ")[0]!])),
    id: (prefix) => `${prefix}${++counters[prefix]}`,
    untrusted: (kind, text) => {
      const clean = redactText(String(text)).slice(0, 600);
      const found = untrusted.find((u) => u.text === clean);
      if (found) return found.id;
      const id = `E${untrusted.length + 1}`;
      if (untrusted.length < MAX_UNTRUSTED) untrusted.push({ id, kind, text: clean });
      return id;
    },
  };

  const discovered = new Map((await discoverSources(db)).map((d) => [d.key, d]));
  const categories: CategoryBlock[] = [];
  const findings: (DraftFinding & { category: string })[] = [];
  const sources: SourceStatus[] = [];
  for (const key of scope.categories) {
    const def = CATEGORIES.find((c) => c.key === key);
    const build = BUILDERS[key];
    if (!def || !build) continue;
    const chosen = def.sources.filter((s) => scope.sources === "all" || scope.sources.includes(s));
    const started = Date.now();
    let part: Part | null = null;
    let error: string | null = null;
    const missing = chosen.filter((s) => discovered.get(s)?.status === "unavailable");
    if (chosen.length && missing.length < chosen.length) {
      try {
        part = await build(ctx);
      } catch (e) {
        error = redactText((e as Error).message).slice(0, 300);
        log.warn("report category failed", { operation: "report_build", category: key, error });
      }
    }
    const ms = Date.now() - started;
    for (const s of def.sources) {
      const d = discovered.get(s);
      const meta = sourceOf(s)!;
      const base = { key: s, label: meta.label, category: key, tables: meta.tables, ms };
      if (!chosen.includes(s)) sources.push({ ...base, status: "not_selected", rows: null, detail: "not selected for this report" });
      else if (error) sources.push({ ...base, status: "error", rows: null, detail: `the category could not be built: ${error}` });
      else if (!d || d.status === "unavailable") sources.push({ ...base, status: "unavailable", rows: null, detail: d?.detail ?? "not available" });
      else if (d.status === "empty") sources.push({ ...base, status: meta.external ? "unavailable" : "empty", rows: 0, detail: d.detail });
      else {
        const rows = part?.rows[s];
        sources.push({ ...base, status: rows === 0 ? "empty" : rows === null || rows === undefined ? "ok" : "ok", rows: rows ?? null, detail: rows === 0 ? "no rows in these dates" : d.detail });
      }
    }
    const states = sources.filter((s) => s.category === key && s.status !== "not_selected");
    const ok = states.filter((s) => s.status === "ok" || s.status === "empty").length;
    const status: CategoryBlock["status"] = !part || ok === 0 ? "unavailable" : ok < states.length ? "partial" : "ok";
    const note = error ? `This category could not be built: ${error}` : !part ? `No source of this category is available: ${states.map((s) => `${s.label} (${s.detail})`).join("; ")}` : (part.note ?? (status === "partial" ? `Not available: ${states.filter((s) => s.status === "unavailable" || s.status === "error").map((s) => s.label).join(", ")}.` : null));
    categories.push({ key, label: def.label, status, note, kpis: part?.kpis ?? [], charts: part?.charts ?? [], tables: part?.tables ?? [] });
    for (const f of part?.findings ?? []) findings.push({ ...f, category: key });
    if (status !== "ok" && chosen.length) {
      const evidence: string[] = [];
      findings.push({ category: key, severity: "low", title: `${def.label}: data ${status === "partial" ? "partly " : ""}unavailable`, detail: note ?? "", impact: "This part of the report is incomplete; conclusions about it are not possible.", evidence, confirmed: true });
    }
  }

  // Findings: most severe first, numbered F1…; a finding without evidence cites its category's first figure.
  const numbered: Finding[] = findings
    .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity))
    .map((f, i) => {
      const cat = categories.find((c) => c.key === f.category);
      const evidence = f.evidence.length ? f.evidence : cat?.kpis[0] ? [cat.kpis[0].id] : [];
      return { ...f, id: `F${i + 1}`, evidence };
    });

  const facts = factsOf(categories);
  const headline = categories.flatMap((c) => c.kpis.slice(0, c.key === "llm_cost" || c.key === "crewai" ? 2 : 1)).slice(0, 8);
  return {
    schema: REPORT_SCHEMA,
    id: input.id,
    title: input.title,
    generatedAt: (input.now ?? new Date()).toISOString(),
    site: input.site,
    tenant: input.tenant,
    range,
    scope,
    summary: { headline },
    categories,
    findings: numbered,
    sources,
    facts,
    untrusted,
  };
}

/**
 * Every figure the AI may cite, formatted as the report shows it: each KPI (and its previous value and change), then
 * the cells of each table's first rows. Ids are the KPI's (M3), "M3p" / "M3c", and "T2.r1.cost" for a cell.
 */
export function factsOf(categories: CategoryBlock[]): Fact[] {
  const out: Fact[] = [];
  const add = (f: Fact) => out.length < MAX_FACTS && out.push(f);
  const kpiFacts = (c: CategoryBlock, k: Kpi) => {
    if (k.value === null) return;
    add({ id: k.id, label: `${c.label}: ${k.label}`, value: fmt(k.value, k.format) });
    if (k.previous !== null && k.previous !== undefined) add({ id: `${k.id}p`, label: `${c.label}: ${k.label}, previous period`, value: fmt(k.previous, k.format) });
    if (k.change !== null && k.change !== undefined) add({ id: `${k.id}c`, label: `${c.label}: ${k.label}, change`, value: signedPct(k.change) });
  };
  for (const c of categories) for (const k of c.kpis) kpiFacts(c, k);
  for (const c of categories)
    for (const t of c.tables)
      t.rows.slice(0, 8).forEach((row, i) => {
        const name = String(row[t.columns[0]?.key ?? ""] ?? "").slice(0, 80);
        for (const col of t.columns.slice(1)) {
          const v = row[col.key];
          if (typeof v === "number" && col.format && col.format !== "text") add({ id: `${t.id}.r${i + 1}.${col.key}`, label: `${t.title}: ${name}, ${col.label}`, value: fmt(v, col.format) });
        }
      });
  return out;
}

/** Prompt family → "crew label · crew key", from the agent's crew catalogue (null when the agent does not answer). */
export async function crewFamilies(): Promise<Map<string, string>> {
  try {
    const { crewCatalogue } = await import("../seo-agent/client");
    const { items } = await crewCatalogue();
    return new Map(items.filter((c) => (c as { prompt_version?: string }).prompt_version).map((c) => [family((c as { prompt_version?: string }).prompt_version), `${(c as { label?: string }).label ?? c.crew} · ${c.crew}`]));
  } catch {
    return new Map();
  }
}
