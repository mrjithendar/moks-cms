import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { rowsOf } from "@/db/rows";
import { ASK_LIMITS } from "./ask";
import { askEnabled } from "./config";
import { agentEnabled } from "./endpoint";

/**
 * Ask the Blog settings (Admin → Automation & AI → Ask the Blog): one JSON document in the `setting` table
 * (key "ask_blog"), validated with zod and merged over the defaults. Read from the database on every call, like the
 * SEO settings: production runs two replicas, so a per-process copy could not be invalidated on the other one.
 *
 * Three things decide whether the assistant is on:
 * - ASK_BLOG_ENABLED (environment, web app and seo-agent): the deployment's master kill switch;
 * - the seo-agent, which answers the questions, is found and on (endpoint.ts agentStatus());
 * - `enabled` here: the admin's switch, applied without a restart.
 * All three must be on. The seo-agent reads the same row (moks-seo-agent/app/ask_runtime.py) for the fields it owns:
 * enabled, audience, dailyBudgetUsd, cacheTtlSeconds, answerLength, fallbackMessage and conversation.{followUps, turns,
 * pageContext, feedback}. Keep the defaults in step.
 */
export const ASK_SETTINGS_KEY = "ask_blog";

export const ASK_AUDIENCES = ["members", "everyone"] as const;
export type AskAudience = (typeof ASK_AUDIENCES)[number];
export const ANSWER_LENGTHS = ["short", "standard", "detailed"] as const;
export type AnswerLength = (typeof ANSWER_LENGTHS)[number];
export const LAUNCHER_STYLES = ["pill", "icon"] as const;
export type LauncherStyle = (typeof LAUNCHER_STYLES)[number];

// The path rules are shared with the client launcher, so they live with the client types.
export { ASK_ALWAYS_HIDDEN, askHiddenOn, underPrefix } from "@/components/ask/types";

/** One line of reader-facing text: no line breaks or control characters (rendered as text, never as HTML). */
const line = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .regex(/^[^\u0000-\u001f\u007f]*$/, "One line of plain text.");
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

export const askSettingsSchema = z.object({
  /** The admin's switch. Off by default: the assistant goes live only when an admin turns it on. */
  enabled: z.boolean(),
  /** "members": only signed-in readers may ask; "everyone": anyone may. */
  audience: z.enum(ASK_AUDIENCES),
  /** The inline cards: at the end of the home page and of each article. */
  placement: z.object({ home: z.boolean(), articles: z.boolean() }),
  /** The chat launcher in the corner of every public page (except ASK_ALWAYS_HIDDEN and `hideOn`). */
  sitewide: z.object({
    enabled: z.boolean(),
    launcher: z.enum(LAUNCHER_STYLES),
    hideOn: z
      .array(
        z
          .string()
          .trim()
          .max(120)
          .regex(/^\/[A-Za-z0-9._~\/-]*$/, "A path starting with /, e.g. /python-practice."),
      )
      .max(20),
  }),
  conversation: z.object({
    /** Send the last `turns` turns with a question so the agent can rewrite a follow-up as a standalone question. */
    followUps: z.boolean(),
    turns: int(1, 5),
    /** Keep the conversation in the tab (sessionStorage) across reloads. Off: it lasts until the page is reloaded. */
    keepThread: z.boolean(),
    /** On article pages, send the article so retrieval ranks its sections a little higher. */
    pageContext: z.boolean(),
    /** Helpful / Not helpful under each answer (stored on the question log row, no account or IP). */
    feedback: z.boolean(),
  }),
  copy: z.object({
    button: line(1, 40),
    intro: line(1, 200),
    placeholder: line(0, 120),
    disclaimer: line(1, 300),
    /** Example questions shown as buttons that fill the question box. */
    examples: z.array(line(3, 120)).max(4),
  }),
  limits: z.object({
    perMinute: int(1, 30),
    perDay: int(1, 1000),
    maxQuestion: int(50, ASK_LIMITS.maxQuestion),
  }),
  /** Daily spend cap in USD. The seo-agent never goes above its own ASK_BLOG_DAILY_BUDGET_USD, whatever is saved here. */
  dailyBudgetUsd: z.coerce.number().min(0.05).max(50),
  /** How long an answer is reused for the same question (0 = never). */
  cacheTtlSeconds: int(0, 86_400),
  answerLength: z.enum(ANSWER_LENGTHS),
  /** Shown when no article answers the question. */
  fallbackMessage: line(1, 200),
});
export type AskSettings = z.infer<typeof askSettingsSchema>;

export const DEFAULT_ASK_SETTINGS: AskSettings = {
  enabled: false,
  audience: "members",
  placement: { home: true, articles: true },
  sitewide: { enabled: true, launcher: "pill", hideOn: [] },
  conversation: { followUps: true, turns: 3, keepThread: true, pageContext: true, feedback: true },
  copy: {
    button: "Ask the Blog",
    intro: "Have a question? Get an answer from the articles on this site, with links to the sections it comes from.",
    placeholder: "e.g. How does cert-manager renew certificates?",
    disclaimer: "Answers come only from articles on this site. Questions are stored without your IP address to improve the blog.",
    examples: [],
  },
  limits: { perMinute: ASK_LIMITS.perMinute, perDay: ASK_LIMITS.perDay, maxQuestion: ASK_LIMITS.maxQuestion },
  dailyBudgetUsd: 1,
  cacheTtlSeconds: 900,
  answerLength: "standard",
  fallbackMessage: "There is no article on this yet.",
};

type Nested = "placement" | "sitewide" | "conversation" | "copy" | "limits";
type Stored = Partial<Omit<AskSettings, Nested>> & { [K in Nested]?: Partial<AskSettings[K]> };

/** Stored document over the defaults. A row that no longer validates (hand-edited, older shape) falls back to the defaults, so it can never switch the assistant on. */
export function mergeAskSettings(stored: unknown): AskSettings {
  const s = (stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {}) as Stored;
  const d = DEFAULT_ASK_SETTINGS;
  // Rows saved before a block existed (sitewide, conversation) get that block's defaults and keep validating.
  const merged = { ...d, ...s, placement: { ...d.placement, ...s.placement }, sitewide: { ...d.sitewide, ...s.sitewide }, conversation: { ...d.conversation, ...s.conversation }, copy: { ...d.copy, ...s.copy }, limits: { ...d.limits, ...s.limits } };
  const parsed = askSettingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : d;
}

export async function getAskSettings(): Promise<AskSettings> {
  const db = await getDb();
  const [row] = await db.select().from(schema.setting).where(eq(schema.setting.key, ASK_SETTINGS_KEY));
  return mergeAskSettings(row?.value);
}

export type AskState = { on: boolean; envOn: boolean; agentOn: boolean; settings: AskSettings };

/**
 * Whether the assistant is on right now, and its settings. With the environment switch off nothing is read from the
 * database (pages and /api/ask behave exactly as before this setting existed). With the seo-agent disabled it is off
 * whatever the admin saved: nothing could answer.
 */
export async function askState(env: Record<string, string | undefined> = process.env): Promise<AskState> {
  if (!askEnabled(env)) return { on: false, envOn: false, agentOn: false, settings: DEFAULT_ASK_SETTINGS };
  const [settings, agentOn] = await Promise.all([getAskSettings(), agentEnabled({ env }).catch(() => false)]);
  return { on: settings.enabled && agentOn, envOn: true, agentOn, settings };
}

export class AskSettingsError extends Error {
  readonly status = 400;
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message);
  }
}

/** Validate and save the whole document. Returns before/after for the audit log (nothing here is secret). */
export async function saveAskSettings(raw: unknown, actorId: string): Promise<{ before: AskSettings; after: AskSettings }> {
  const parsed = askSettingsSchema.safeParse(raw ?? {});
  if (!parsed.success) throw new AskSettingsError("The settings are not valid.", parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`));
  const next = parsed.data;
  if (next.limits.perDay < next.limits.perMinute) throw new AskSettingsError("The settings are not valid.", ["limits.perDay: must be at least the per-minute limit"]);
  if (new Set(next.copy.examples.map((e) => e.toLowerCase())).size !== next.copy.examples.length) throw new AskSettingsError("The settings are not valid.", ["copy.examples: each example question must be different"]);
  next.sitewide.hideOn = [...new Set(next.sitewide.hideOn.filter((p) => p !== "/" && p !== ""))];
  const before = await getAskSettings();
  const db = await getDb();
  await db
    .insert(schema.setting)
    .values({ key: ASK_SETTINGS_KEY, value: next, updatedBy: actorId })
    .onConflictDoUpdate({ target: schema.setting.key, set: { value: next, updatedBy: actorId, updatedAt: new Date() } });
  return { before, after: next };
}

export type AskStatus = {
  /** Today's (UTC) Ask the Blog spend, as the agent's budget guard counts it. */
  spentTodayUsd: number;
  /** Last 7 days, from the question log. */
  week: { total: number; answered: number; fallback: number; refused: number; cached: number; followUps: number; helpful: number; notHelpful: number };
  openGaps: number;
};

/** Read-only numbers for the admin card. Null when the SEO tables are not migrated yet. */
export async function loadAskStatus(): Promise<AskStatus | null> {
  try {
    const db = await getDb();
    const [spend] = rowsOf<{ s: number }>(await db.execute(sql`select coalesce(sum(cost_usd), 0)::float8 as s from seo_llm_usage where at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc' and purpose like 'ask%'`));
    const outcomes = rowsOf<{ outcome: string; cached: boolean; n: number }>(await db.execute(sql`select outcome, cached, count(*)::int as n from seo_ask_log where at >= now() - interval '7 days' group by outcome, cached`));
    const [gaps] = rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from seo_ask_gaps where status = 'open'`));
    const week = { total: 0, answered: 0, fallback: 0, refused: 0, cached: 0, followUps: 0, helpful: 0, notHelpful: 0 };
    for (const r of outcomes) {
      const n = Number(r.n);
      week.total += n;
      if (r.cached) week.cached += n;
      if (r.outcome === "answered") week.answered += n;
      else if (r.outcome === "fallback") week.fallback += n;
      else if (r.outcome === "refused") week.refused += n;
    }
    // Migration 0029 columns: read apart, so the card still shows the rest before the migration has run.
    try {
      const [c] = rowsOf<{ f: number; h: number; nh: number }>(
        await db.execute(sql`select count(*) filter (where standalone is not null)::int as f, count(*) filter (where feedback = 1)::int as h, count(*) filter (where feedback = -1)::int as nh from seo_ask_log where at >= now() - interval '7 days'`),
      );
      week.followUps = Number(c?.f ?? 0);
      week.helpful = Number(c?.h ?? 0);
      week.notHelpful = Number(c?.nh ?? 0);
    } catch {
      /* not migrated yet */
    }
    return { spentTodayUsd: Number(spend?.s ?? 0), week, openGaps: Number(gaps?.n ?? 0) };
  } catch {
    return null;
  }
}
