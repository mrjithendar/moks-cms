import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema, type Db } from "@/db";
import { rowsOf } from "@/db/rows";

/**
 * LLM budgets (Admin → Automation & AI → LLM budgets): a daily and a monthly limit for each model, and for each
 * provider (all of its models together, for example the credit on one Anthropic account). One JSON document in the
 * `setting` table, key "llm_budgets". Every limit is optional: a missing or empty one is no limit, so nothing changes
 * until an admin sets one, and nothing here presets a value.
 *
 * Spend is counted from seo_llm_usage, the table both the web app (seo-intel/claude.ts) and the seo-agent
 * (moks-seo-agent/app/llm.py) write for every Claude call: drafts, agent flows, Ask the Blog and the news desk alike,
 * since they all spend the same account's money. Message batches still in progress count at their estimate. Days and
 * months are UTC calendar periods, the same ones Anthropic's spend limits reset on.
 *
 * These come on top of the feature caps, which still apply: the drafts monthly budget, Ask the Blog's daily budget,
 * the news desk's caps and AI visibility's monthly budget. AI visibility answers are recorded in seo_ai_answers, not
 * seo_llm_usage, so they are capped by their own budget only and are not counted here.
 *
 * The seo-agent reads the same row (moks-seo-agent/app/llm_limits.py, cached about 30 seconds) and checks it before
 * each call. Keep the document's shape in step with that parser.
 */
export const LLM_BUDGETS_KEY = "llm_budgets";

const MAX_USD = 100_000;
const limit = z.union([z.null(), z.number().finite().min(0).max(MAX_USD)]);
const entry = z.object({ dailyUsd: limit.default(null), monthlyUsd: limit.default(null) }).strict();
const MODEL = /^[A-Za-z0-9._:\-/@]{1,120}$/;
const PROVIDER = /^[a-z0-9_-]{2,40}$/;

export const llmBudgetsSchema = z
  .object({
    models: z.record(z.string().regex(MODEL, "Use the provider's model id."), entry).default({}),
    providers: z.record(z.string().regex(PROVIDER, "Use a provider name such as anthropic."), entry).default({}),
  })
  .strict();

export type LlmLimit = z.infer<typeof entry>;
export type LlmBudgets = z.infer<typeof llmBudgetsSchema>;
export const EMPTY_LLM_BUDGETS: LlmBudgets = { models: {}, providers: {} };

/** Entries without any limit are left out: an empty row and no row mean the same thing. */
function compact(b: LlmBudgets): LlmBudgets {
  const keep = (r: Record<string, LlmLimit>) => Object.fromEntries(Object.entries(r).filter(([, v]) => v.dailyUsd !== null || v.monthlyUsd !== null).sort(([a], [b]) => a.localeCompare(b)));
  return { models: keep(b.models), providers: keep(b.providers) };
}

/** The stored document, or no limits when there is none or it does not parse (a bad row must not stop every call). */
export function parseLlmBudgets(value: unknown): LlmBudgets {
  const r = llmBudgetsSchema.safeParse(value ?? {});
  return r.success ? compact(r.data) : EMPTY_LLM_BUDGETS;
}

export async function getLlmBudgets(db?: Db): Promise<LlmBudgets> {
  const d = db ?? (await getDb());
  const [row] = await d.select().from(schema.setting).where(eq(schema.setting.key, LLM_BUDGETS_KEY));
  return parseLlmBudgets(row?.value);
}

export class LlmBudgetsError extends Error {
  readonly status = 400;
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message);
  }
}

/** Validate and save the whole document. Returns before/after for the audit log (nothing here is secret). */
export async function saveLlmBudgets(raw: unknown, actorId: string): Promise<{ before: LlmBudgets; after: LlmBudgets }> {
  const parsed = llmBudgetsSchema.safeParse(raw ?? {});
  if (!parsed.success) throw new LlmBudgetsError("The budgets are not valid.", parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`));
  const next = compact(parsed.data);
  if (Object.keys(next.models).length > 100 || Object.keys(next.providers).length > 20) throw new LlmBudgetsError("The budgets are not valid.", ["Too many entries (100 models, 20 providers at most)."]);
  const db = await getDb();
  const before = await getLlmBudgets(db);
  await db
    .insert(schema.setting)
    .values({ key: LLM_BUDGETS_KEY, value: next, updatedBy: actorId })
    .onConflictDoUpdate({ target: schema.setting.key, set: { value: next, updatedBy: actorId, updatedAt: new Date() } });
  return { before, after: next };
}

// --- Periods and spend -----------------------------------------------------------------------------------------------

export function periodStart(unit: "day" | "month", now = new Date()): Date {
  return unit === "day" ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function periodEnd(unit: "day" | "month", now = new Date()): Date {
  return unit === "day" ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/** Batches in progress have no usage rows yet, only their estimate: counted for the model, as Anthropic spend. */
async function spentSince(db: Db, since: Date, by: { model?: string; provider?: string }): Promise<number> {
  const model = by.model ?? null;
  const provider = by.provider ?? null;
  const [u] = rowsOf<{ s: number }>(
    await db.execute(sql`select coalesce(sum(cost_usd), 0)::float8 as s from seo_llm_usage where at >= ${since.toISOString()}
      and (${model}::text is null or model = ${model}) and (${provider}::text is null or provider = ${provider})`),
  );
  const [b] = rowsOf<{ s: number }>(
    await db.execute(sql`select coalesce(sum(estimated_cost_usd), 0)::float8 as s from seo_llm_batches where status = 'in_progress'
      and (${model}::text is null or model = ${model}) and (${provider}::text is null or ${provider} = 'anthropic')`),
  );
  return Number(u?.s ?? 0) + Number(b?.s ?? 0);
}

const money = (n: number) => `$${n.toFixed(2)}`;
const WHERE = "change it in Admin → Automation & AI → LLM budgets";

/**
 * Would a call costing up to `estimateUsd` on `model` (from `provider`) cross a model or provider limit? Null when it
 * fits, or else the reason, naming the limit, what was used and when it resets. A limit that is already used up stops
 * even a call that would cost nothing extra, as a spent budget does not come back by waiting.
 */
export async function checkLlmBudget(db: Db, model: string, estimateUsd: number, provider = "anthropic", now = new Date(), budgets?: LlmBudgets): Promise<string | null> {
  const b = budgets ?? (await getLlmBudgets(db));
  const checks: { label: string; by: { model?: string; provider?: string }; lim: LlmLimit | undefined }[] = [
    { label: `The {unit} budget of ${model}`, by: { model }, lim: b.models[model] },
    { label: `The {unit} total for all ${provider} models`, by: { provider }, lim: b.providers[provider] },
  ];
  for (const c of checks) {
    for (const unit of ["day", "month"] as const) {
      const max = unit === "day" ? c.lim?.dailyUsd : c.lim?.monthlyUsd;
      if (max === null || max === undefined) continue;
      const spent = await spentSince(db, periodStart(unit, now), c.by);
      if (spent + estimateUsd > max || (spent > 0 && spent >= max)) {
        const more = spent < max ? `, and this call could cost up to ${money(estimateUsd)}` : "";
        const label = c.label.replace("{unit}", unit === "day" ? "daily" : "monthly");
        return `${label} is reached: ${money(spent)} of ${money(max)} used ${unit === "day" ? "today" : "this month"}${more}. It resets ${periodEnd(unit, now).toISOString().slice(0, 16).replace("T", " ")} UTC; ${WHERE}.`;
      }
    }
  }
  return null;
}

export type ModelSpend = { model: string; provider: string; todayUsd: number; monthUsd: number; calls: number; purposes: string[] };
export type ProviderSpend = { provider: string; todayUsd: number; monthUsd: number; forecastUsd: number };
export type LlmSpend = { monthStart: string; dayResetsAt: string; monthResetsAt: string; models: ModelSpend[]; providers: ProviderSpend[] };

/** This month's spend by model and provider, today's alongside, and a month-end forecast at the average daily rate. */
export async function llmSpend(db: Db, now = new Date()): Promise<LlmSpend> {
  const month = periodStart("month", now);
  const day = periodStart("day", now);
  const rows = rowsOf<{ provider: string; model: string; today: number; month: number; calls: number; purposes: string[] | null }>(
    await db.execute(sql`select provider, model, coalesce(sum(cost_usd) filter (where at >= ${day.toISOString()}), 0)::float8 as today, coalesce(sum(cost_usd), 0)::float8 as month,
      count(*)::int as calls, array_agg(distinct split_part(purpose, '.', 1)) as purposes
      from seo_llm_usage where at >= ${month.toISOString()} group by provider, model`),
  );
  const batches = rowsOf<{ model: string; s: number }>(await db.execute(sql`select model, coalesce(sum(estimated_cost_usd), 0)::float8 as s from seo_llm_batches where status = 'in_progress' group by model`));
  const models = new Map<string, ModelSpend>();
  for (const r of rows) {
    const k = `${r.provider}\u0000${r.model}`;
    const m = models.get(k) ?? { model: r.model, provider: r.provider, todayUsd: 0, monthUsd: 0, calls: 0, purposes: [] };
    m.todayUsd += Number(r.today);
    m.monthUsd += Number(r.month);
    m.calls += Number(r.calls);
    m.purposes = [...new Set([...m.purposes, ...(r.purposes ?? [])])].sort();
    models.set(k, m);
  }
  for (const b of batches) {
    const k = `anthropic\u0000${b.model}`;
    const m = models.get(k) ?? { model: b.model, provider: "anthropic", todayUsd: 0, monthUsd: 0, calls: 0, purposes: [] };
    m.todayUsd += Number(b.s);
    m.monthUsd += Number(b.s);
    m.purposes = [...new Set([...m.purposes, "batch"])].sort();
    models.set(k, m);
  }
  const elapsedDays = Math.max((now.getTime() - month.getTime()) / 86_400_000, 1);
  const daysInMonth = (periodEnd("month", now).getTime() - month.getTime()) / 86_400_000;
  const providers = new Map<string, ProviderSpend>();
  for (const m of models.values()) {
    const p = providers.get(m.provider) ?? { provider: m.provider, todayUsd: 0, monthUsd: 0, forecastUsd: 0 };
    p.todayUsd += m.todayUsd;
    p.monthUsd += m.monthUsd;
    p.forecastUsd = (p.monthUsd / elapsedDays) * daysInMonth;
    providers.set(m.provider, p);
  }
  return {
    monthStart: month.toISOString().slice(0, 10),
    dayResetsAt: periodEnd("day", now).toISOString(),
    monthResetsAt: periodEnd("month", now).toISOString(),
    models: [...models.values()].sort((a, b) => b.monthUsd - a.monthUsd || a.model.localeCompare(b.model)),
    providers: [...providers.values()].sort((a, b) => b.monthUsd - a.monthUsd || a.provider.localeCompare(b.provider)),
  };
}
