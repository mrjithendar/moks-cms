import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "../audit";
import { broadcastInvalidate, onInvalidate } from "../cache-bus";
import type { Actor } from "../posts";
import { PracticeError } from "./errors";
import { llmConfig } from "../llm/client";

/**
 * Admin → Python practice → Settings, stored in the `setting` table (key "practice").
 *
 * The executor's address and token are deployment secrets (PRACTICE_EXECUTOR_URL, PRACTICE_EXECUTOR_TOKEN) and
 * never stored here. Running code needs both those variables and `execution.enabled`: the switch stays off
 * until the sandbox (gVisor) is installed and verified (docs/PYTHON_PRACTICE_EXECUTOR.md).
 *
 * The AI tutor has no provider, model, key or price here (D-110): it calls LiteLLM (lib/llm/client.ts) with its own
 * virtual key (LITELLM_PRACTICE_API_KEY) and alias (LITELLM_MODEL_PRACTICE), and LiteLLM enforces its budget.
 */
const KEY = "practice";

export type Runtime = { id: string; label: string; enabled: boolean };

export type PracticeSettings = {
  execution: { enabled: boolean; runtimes: Runtime[]; defaultRuntime: string; perTestSeconds: number; totalSeconds: number; memoryMb: number };
  /** aiRequestsPerDay: per person, a fairness limit (the money limit is the tutor key's budget in LiteLLM). */
  quotas: { runsPerHour: number; submitsPerHour: number; maxPending: number; aiRequestsPerDay: number };
  ai: { enabled: boolean; timeoutMs: number; maxOutputTokens: number };
  leaderboard: { enabled: boolean };
  retention: { activityDays: number; codeDays: number };
};

export const DEFAULT_SETTINGS: PracticeSettings = {
  execution: { enabled: false, runtimes: [{ id: "python-3.13", label: "Python 3.13", enabled: true }], defaultRuntime: "python-3.13", perTestSeconds: 2, totalSeconds: 10, memoryMb: 256 },
  quotas: { runsPerHour: 120, submitsPerHour: 60, maxPending: 2, aiRequestsPerDay: 40 },
  ai: { enabled: false, timeoutMs: 30_000, maxOutputTokens: 900 },
  leaderboard: { enabled: true },
  retention: { activityDays: 730, codeDays: 365 },
};

let cached: Promise<PracticeSettings> | null = null;
onInvalidate("practice", () => {
  cached = null;
});

/** A section over its defaults, without keys it no longer has (D-110 retired the tutor's provider, model, key and prices). */
function known<T extends object>(d: T, s: Partial<T> | undefined): T {
  return { ...d, ...Object.fromEntries(Object.entries(s ?? {}).filter(([k]) => k in d)) } as T;
}

function merge(stored: Partial<PracticeSettings> | undefined): PracticeSettings {
  const s = stored ?? {};
  return {
    execution: { ...DEFAULT_SETTINGS.execution, ...s.execution },
    quotas: known(DEFAULT_SETTINGS.quotas, s.quotas),
    ai: known(DEFAULT_SETTINGS.ai, s.ai),
    leaderboard: { ...DEFAULT_SETTINGS.leaderboard, ...s.leaderboard },
    retention: { ...DEFAULT_SETTINGS.retention, ...s.retention },
  };
}

export async function getPracticeSettings(): Promise<PracticeSettings> {
  cached ??= (async () => {
    const db = await getDb();
    const [row] = await db.select().from(schema.setting).where(eq(schema.setting.key, KEY));
    return merge(row?.value as Partial<PracticeSettings> | undefined);
  })().catch((err) => {
    cached = null;
    throw err;
  });
  return cached;
}

export function executorEnv(env: Record<string, string | undefined> = process.env): { url: string; token: string } | null {
  const url = env.PRACTICE_EXECUTOR_URL?.trim().replace(/\/+$/, "");
  const token = env.PRACTICE_EXECUTOR_TOKEN?.trim();
  return url && token ? { url, token } : null;
}

/** Whether Run/Submit work right now (switch on and executor configured). */
export async function executionAvailable(): Promise<boolean> {
  return (await getPracticeSettings()).execution.enabled && executorEnv() !== null;
}

/** On, and able to call a model: switched on here and LiteLLM configured (LITELLM_BASE_URL, LITELLM_API_KEY). */
export function aiConfigured(settings: PracticeSettings, env: Record<string, string | undefined> = process.env): boolean {
  return settings.ai.enabled && llmConfig(env) !== null;
}

const num = (min: number, max: number) => z.coerce.number().min(min).max(max);
const settingsInput = z.object({
  execution: z.object({
    enabled: z.boolean(),
    runtimes: z.array(z.object({ id: z.string().regex(/^[a-z0-9.\-]{1,32}$/), label: z.string().trim().min(1).max(40), enabled: z.boolean() })).min(1).max(10),
    defaultRuntime: z.string(),
    perTestSeconds: num(0.5, 5),
    totalSeconds: num(2, 20),
    memoryMb: num(64, 256),
  }),
  quotas: z.object({ runsPerHour: num(1, 2000), submitsPerHour: num(1, 1000), maxPending: num(1, 10), aiRequestsPerDay: num(0, 1000) }),
  ai: z.object({ enabled: z.boolean(), timeoutMs: num(2000, 120_000), maxOutputTokens: num(100, 4000) }),
  leaderboard: z.object({ enabled: z.boolean() }),
  retention: z.object({ activityDays: num(30, 3650), codeDays: num(30, 3650) }),
});

export async function savePracticeSettings(actor: Actor, raw: unknown): Promise<void> {
  if (actor.role !== "admin") throw new PracticeError("Only admins can change practice settings.", 403, "forbidden");
  const parsed = settingsInput.safeParse(raw);
  if (!parsed.success) throw new PracticeError(`Check the settings: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const v = parsed.data;
  if (!v.execution.runtimes.some((r) => r.id === v.execution.defaultRuntime && r.enabled)) throw new PracticeError("The default runtime must be one of the enabled runtimes.");
  const next: PracticeSettings = v;
  const db = await getDb();
  await db
    .insert(schema.setting)
    .values({ key: KEY, value: next, updatedBy: actor.id })
    .onConflictDoUpdate({ target: schema.setting.key, set: { value: next, updatedBy: actor.id, updatedAt: new Date() } });
  cached = null;
  broadcastInvalidate("practice");
  await audit(actor, "practice.settings", undefined, {
    executionEnabled: v.execution.enabled,
    aiEnabled: v.ai.enabled,
    quotas: v.quotas,
  });
}
