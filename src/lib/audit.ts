import { getDb, schema } from "@/db";
import { clientIp } from "./client-ip";
import { log } from "./log";

export const SEVERITIES = ["info", "notice", "warning", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

/**
 * Default severity by action (exact name, then prefix). Warnings and criticals are what Admin → Audit log and
 * the dashboard's security card surface: failed or blocked sign-ins, privilege and credential changes.
 */
const SEVERITY: [string, Severity][] = [
  ["auth.login_failed", "warning"],
  ["auth.rate_limited", "warning"],
  ["auth.captcha_failed", "warning"],
  ["auth.banned_login", "critical"],
  ["auth.social_failed", "notice"],
  ["auth.password_reset_requested", "notice"],
  ["auth.password_changed", "notice"],
  ["auth.signup", "info"],
  ["auth.login", "info"],
  ["user.role", "critical"],
  ["user.ban", "warning"],
  ["user.delete", "warning"],
  ["user.impersonate", "critical"],
  ["user.password", "warning"],
  ["apikey.create", "warning"],
  ["apikey.", "notice"],
  ["integrations.", "warning"],
  ["storage.", "warning"],
  ["email.", "notice"],
  ["invoice.", "notice"],
  ["backup.download", "warning"],
  ["backup.", "notice"],
  ["site-config.publish", "notice"],
  ["database.", "warning"],
  ["audit.export", "notice"],
  ["practice.settings", "warning"],
  ["practice.problem.archive", "notice"],
  ["practice.abuse", "warning"],
  ["practice.", "info"],
];

export function severityOf(action: string): Severity {
  return SEVERITY.find(([k]) => action === k)?.[1] ?? SEVERITY.find(([k]) => k.endsWith(".") && action.startsWith(k))?.[1] ?? "info";
}

export type RequestInfo = { ip: string | null; userAgent: string | null };

/** The visitor's address as the proxies in front report it (lib/client-ip.ts; never a value the client can choose). */
export function requestInfoFrom(h: Headers): RequestInfo {
  const ip = clientIp(h);
  return { ip: ip ? ip.slice(0, 64) : null, userAgent: h.get("user-agent")?.slice(0, 300) ?? null };
}

/** IP and user agent of the current request, when there is one (server actions, route handlers, auth hooks). */
async function currentRequest(): Promise<RequestInfo> {
  try {
    const { headers } = await import("next/headers");
    return requestInfoFrom(await headers());
  } catch {
    return { ip: null, userAgent: null };
  }
}

/**
 * Append-only record of admin/API/auth actions. Never store secrets (or passwords) in `detail`.
 * Pass the caller's transaction as `db` to commit the entry with the change it describes.
 */
export async function audit(
  actor: { id?: string | null; label: string },
  action: string,
  target?: string,
  detail?: Record<string, unknown>,
  opts: { severity?: Severity; request?: RequestInfo; db?: Pick<Awaited<ReturnType<typeof getDb>>, "insert"> } = {},
) {
  const req = opts.request ?? (await currentRequest());
  const db = opts.db ?? (await getDb());
  await db.insert(schema.auditLog).values({
    actorId: actor.id ?? null,
    actor: actor.label,
    action,
    target: target ?? null,
    detail: detail ?? null,
    ip: req.ip,
    userAgent: req.userAgent,
    severity: opts.severity ?? severityOf(action),
  });
}

/** Audit without ever failing the caller (auth hooks: a broken audit write must not block sign-in). */
export async function auditSafe(...args: Parameters<typeof audit>) {
  try {
    await audit(...args);
  } catch (err) {
    log.warn("audit write failed", { action: args[1], err });
  }
}
