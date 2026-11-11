import { and, count, desc, eq, gt, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "./audit";
import { log } from "./log";
import { sendMail } from "./mail";
import type { Actor } from "./posts";
import { PostError } from "./posts";
import { getSettings } from "./settings";
import { BUDGETS, ENQUIRY_KINDS, ENQUIRY_LABELS, TIMELINES } from "./hire-me";
import { getPublishedConfig } from "./site-config/store";
import { verifyTurnstile } from "./turnstile";

export const contactInput = z.object({
  name: z.string().trim().min(2, "Enter your name").max(100),
  email: z.email("Enter a valid email").trim().max(200),
  subject: z.string().trim().min(3, "Enter a subject").max(150),
  message: z.string().trim().min(10, "Your message is too short").max(5000),
});

/**
 * Stored in Postgres (contact_message); the admin is notified by email when mail is configured.
 * `signedIn` (from the server session, never the client) skips Turnstile: sign-in already passed one.
 */
export async function submitContact(raw: unknown, turnstileToken: string | null, ip?: string | null, { signedIn = false } = {}) {
  if (!(await getSettings()).features.contactForm) throw new PostError("The contact form is closed.", 403);
  const parsed = contactInput.safeParse(raw);
  if (!parsed.success) throw new PostError("Please check the form.", 400, parsed.error.issues.map((i) => i.message));
  if (!signedIn && !(await verifyTurnstile(turnstileToken, ip))) throw new PostError("Please complete the human verification again.", 400);
  const db = await getDb();
  await enforceLimits(parsed.data.email);
  await db.insert(schema.contactMessage).values(parsed.data);
  log.info("contact message received", { subjectLength: parsed.data.subject.length });
  const admins = await db.select({ email: schema.user.email }).from(schema.user).where(eq(schema.user.role, "admin"));
  await Promise.all(
    admins.map((a) =>
      sendMail(a.email, `New message: ${parsed.data.subject}`, `From: ${parsed.data.name} <${parsed.data.email}>\n\n${parsed.data.message}\n\nReply from your email client, or read it in Admin → Messages.`),
    ),
  );
}

/** Contact messages and enquiries share one hourly budget: 3 per address, 100 in total. */
async function enforceLimits(email: string) {
  const db = await getDb();
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const [{ mine } = { mine: 0 }] = await db.select({ mine: count() }).from(schema.contactMessage).where(and(gt(schema.contactMessage.createdAt, hourAgo), eq(schema.contactMessage.email, email)));
  const [{ all } = { all: 0 }] = await db.select({ all: count() }).from(schema.contactMessage).where(gt(schema.contactMessage.createdAt, hourAgo));
  if (mine >= 3 || all >= 100) throw new PostError("Too many messages right now. Please try again later.", 400);
}

const optionalChoice = <T extends readonly [string, ...string[]]>(values: T) => z.union([z.literal(""), z.enum(values)]).optional().default("");

export const enquiryInput = z.object({
  kind: z.enum(ENQUIRY_KINDS, "Choose what you need help with"),
  name: z.string().trim().min(2, "Enter your name").max(100),
  email: z.email("Enter a valid email").trim().max(200),
  company: z.string().trim().max(120).optional().default(""),
  budget: optionalChoice(BUDGETS),
  timeline: optionalChoice(TIMELINES),
  message: z.string().trim().min(20, "Tell me a little more (at least 20 characters)").max(5000),
});
export type EnquiryInput = z.input<typeof enquiryInput>;

/**
 * A Hire me enquiry (/hire-me): stored as a contact message with `kind` and `details`, so it lands in Admin → Messages;
 * the admins' email subject starts with the kind ("[Consulting] …") so it can be filtered. Open only while the
 * page is enabled in Admin → Appearance → Hire me. Same Turnstile and hourly limits as the contact form.
 */
export async function submitEnquiry(raw: unknown, turnstileToken: string | null, ip?: string | null, { signedIn = false } = {}) {
  if (!(await getPublishedConfig()).config.hireMe.enabled) throw new PostError("Enquiries are closed.", 403);
  const parsed = enquiryInput.safeParse(raw);
  if (!parsed.success) throw new PostError("Please check the form.", 400, parsed.error.issues.map((i) => i.message));
  if (!signedIn && !(await verifyTurnstile(turnstileToken, ip))) throw new PostError("Please complete the human verification again.", 400);
  const e = parsed.data;
  await enforceLimits(e.email);
  const label = ENQUIRY_LABELS[e.kind];
  const subject = `${label}: ${e.company || e.name}`.slice(0, 150);
  const details = { ...(e.company ? { company: e.company } : {}), ...(e.budget ? { budget: e.budget } : {}), ...(e.timeline ? { timeline: e.timeline } : {}) };
  const db = await getDb();
  await db.insert(schema.contactMessage).values({ name: e.name, email: e.email, subject, message: e.message, kind: e.kind, details });
  log.info("enquiry received", { event: "enquiry_received", kind: e.kind });
  const lines = [`From: ${e.name} <${e.email}>`, `About: ${label}`, ...(e.company ? [`Company: ${e.company}`] : []), ...(e.budget ? [`Budget: ${e.budget}`] : []), ...(e.timeline ? [`Timeline: ${e.timeline}`] : [])];
  const admins = await db.select({ email: schema.user.email }).from(schema.user).where(eq(schema.user.role, "admin"));
  await Promise.all(
    admins.map((a) => sendMail(a.email, `[${label}] ${subject}`, `${lines.join("\n")}\n\n${e.message}\n\nReply from your email client, or read it in Admin → Messages.`)),
  );
}

export type InboxFilter = "new" | "read" | "archived" | "all" | "enquiries";

export async function inbox(status: InboxFilter = "all") {
  const db = await getDb();
  return db
    .select()
    .from(schema.contactMessage)
    .where(status === "all" ? undefined : status === "enquiries" ? isNotNull(schema.contactMessage.kind) : eq(schema.contactMessage.status, status))
    .orderBy(desc(schema.contactMessage.createdAt))
    .limit(300);
}

export async function updateMessage(actor: Actor, id: string, action: "read" | "new" | "archived" | "delete") {
  if (actor.role !== "admin") throw new PostError("Only admins can manage messages.", 403);
  const db = await getDb();
  if (action === "delete") await db.delete(schema.contactMessage).where(eq(schema.contactMessage.id, id));
  else await db.update(schema.contactMessage).set({ status: action }).where(eq(schema.contactMessage.id, id));
  await audit(actor, `message.${action}`, id);
}
