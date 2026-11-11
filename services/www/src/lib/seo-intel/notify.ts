import { siteUrl } from "@/config/site";
import { log } from "../log";
import * as mail from "../mail";
import { reviewQueue } from "./drafts";
import { getSeoSettings } from "./settings";

/**
 * Notifications through the site's existing mail service (src/lib/mail.ts). Nothing is sent unless a recipient is
 * configured (Settings → Drafts → digest recipients) and an email provider is set up (Admin → Storage & email).
 */
type Deps = { send?: (to: string, subject: string, text: string) => Promise<boolean>; mailReady?: () => Promise<boolean> };

export function digestText(items: Awaited<ReturnType<typeof reviewQueue>>, base: string): string {
  const ready = items.filter((i) => i.status === "ready_for_review");
  const failed = items.filter((i) => i.status === "generation_failed");
  const lines = [
    `${ready.length} draft${ready.length === 1 ? "" : "s"} waiting for your review${failed.length ? `, ${failed.length} failed to generate` : ""}.`,
    "",
    ...ready.slice(0, 20).map((i) => `• ${i.title}\n  ${i.breakdown || `${i.changeCount} changes`} · ${i.band} priority · ~${i.reviewMinutes} min\n  ${base}/admin/review/${i.id}`),
    ...(ready.length > 20 ? [`…and ${ready.length - 20} more.`] : []),
    "",
    `Review queue: ${base}/admin/review`,
    "Nothing is published until you approve each article.",
  ];
  return lines.join("\n");
}

export async function sendDraftDigest(now = new Date(), deps: Deps = {}): Promise<{ sent: boolean; drafts: number; reason?: string }> {
  const s = await getSeoSettings();
  const recipients = s.drafts.digest.recipients;
  if (!s.drafts.digest.enabled || !recipients.length) return { sent: false, drafts: 0, reason: "no_recipient" };
  const items = await reviewQueue();
  const ready = items.filter((i) => i.status === "ready_for_review").length;
  if (!ready) return { sent: false, drafts: 0, reason: "nothing_waiting" };
  if (!(await (deps.mailReady ?? mail.mailConfigured)())) return { sent: false, drafts: ready, reason: "mail_not_configured" };
  const send = deps.send ?? mail.sendMail;
  const text = digestText(items, siteUrl());
  let ok = 0;
  for (const to of recipients) if (await send(to, `SEO review queue: ${ready} draft${ready === 1 ? "" : "s"} waiting (${now.toISOString().slice(0, 10)})`, text)) ok++;
  log.info("seo draft digest sent", { operation: "seo_digest", outcome: ok ? "sent" : "failed", count: ok });
  return { sent: ok > 0, drafts: ready };
}

/** Immediate alert (failed post-publish verification, tracked-keyword moves): same recipients, same opt-in. */
export async function sendSeoAlert(subject: string, text: string, deps: Deps = {}): Promise<boolean> {
  const s = await getSeoSettings();
  const recipients = [...new Set([...s.drafts.digest.recipients, ...s.reports.recipients])];
  if (!recipients.length || !(await (deps.mailReady ?? mail.mailConfigured)())) return false;
  const send = deps.send ?? mail.sendMail;
  let ok = false;
  for (const to of recipients) ok = (await send(to, subject, text)) || ok;
  return ok;
}
