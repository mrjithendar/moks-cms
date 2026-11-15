import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";

export type Maintenance = { enabled: boolean; message: string; retryAfterMinutes: number };
const OFF: Maintenance = { enabled: false, message: "", retryAfterMinutes: 30 };
const TTL_MS = 10_000;
/** The only time a request waits for the database here: the first one after a start, and never longer than this. */
const FIRST_READ_WAIT_MS = 1_500;
/** A read that has not answered by now counts as failed (the last known state stays; the next one is tried after the TTL). */
const READ_TIMEOUT_MS = 5_000;
let cached: { value: Maintenance; at: number } | undefined;
let refreshing: Promise<void> | null = null;
/** Bumped by resetMaintenanceCache(): a read started before a reset must not write its result after it. */
let generation = 0;

type Loader = () => Promise<Maintenance>;

async function loadFromDb(): Promise<Maintenance> {
  const db = await getDb();
  const [row] = await db.select({ config: schema.siteConfig.config }).from(schema.siteConfig).where(eq(schema.siteConfig.key, "published"));
  const m = (row?.config as { general?: { maintenance?: Partial<Maintenance> } } | undefined)?.general?.maintenance;
  if (!m || m.enabled !== true) return OFF;
  return {
    enabled: true,
    message: typeof m.message === "string" ? m.message.slice(0, 300) : "",
    retryAfterMinutes: Number.isInteger(m.retryAfterMinutes) ? Math.min(1440, Math.max(5, m.retryAfterMinutes!)) : 30,
  };
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("maintenance read timed out")), ms);
    (timer as { unref?: () => void }).unref?.();
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** One read at a time, however many requests ask. Never rejects: a failed read keeps the last known state. */
function refresh(load: Loader): Promise<void> {
  if (refreshing) return refreshing;
  const mine = generation;
  const store = (value: Maintenance) => {
    if (mine === generation) cached = { value, at: Date.now() };
  };
  const run: Promise<void> = withTimeout(Promise.resolve().then(load), READ_TIMEOUT_MS)
    .then(store, () => store(cached?.value ?? OFF)) // database unavailable: keep the last known state
    .finally(() => {
      if (refreshing === run) refreshing = null;
    });
  refreshing = run;
  return run;
}

/**
 * The published maintenance switch, for the proxy, which runs in front of every page. The value is read with one
 * small query and kept for 10 s per process; after that the stored value is still answered at once while a single
 * read refreshes it in the background, so no request waits for the database and a database outage does not slow down
 * pages that are served from memory. A change therefore applies on every replica within about 10 seconds. Only the
 * first request after a start waits for the read, at most 1.5 s.
 */
export async function maintenanceState(now = Date.now(), load: Loader = loadFromDb): Promise<Maintenance> {
  if (cached && now - cached.at < TTL_MS) return cached.value;
  if (cached) {
    void refresh(load);
    return cached.value;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, FIRST_READ_WAIT_MS);
    void refresh(load).then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
  return (cached as { value: Maintenance } | undefined)?.value ?? OFF;
}

export function resetMaintenanceCache() {
  generation++;
  cached = undefined;
  refreshing = null;
}

/**
 * Paths that stay available during maintenance: sign-in, admin, account, APIs, assets, health and crawl files, and a
 * client's invoice link (an invoice that was emailed must stay payable).
 */
export const MAINTENANCE_EXEMPT = /^\/(admin|account|login|setup|api|_next|media|images|preview|invoice|icon|apple-icon|favicon\.ico|robots\.txt|ads\.txt)(\/|$|\.)/;

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A self-contained 503 page (no app rendering, no scripts). */
export function maintenancePage(siteName: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Down for maintenance · ${escapeHtml(siteName)}</title><style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;background:#fff;color:#17191d;padding:24px}@media(prefers-color-scheme:dark){body{background:#0e1013;color:#f2f3f5}}main{max-width:32rem;text-align:center}h1{font-size:1.75rem;line-height:1.2;margin:0 0 .75rem}p{margin:0;opacity:.8}</style></head><body><main><h1>${escapeHtml(siteName)} is down for maintenance</h1><p>${escapeHtml(message || "We will be back shortly.")}</p></main></body></html>`;
}
