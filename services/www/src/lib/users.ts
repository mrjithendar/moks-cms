import { count, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "./audit";
import { getAuth, ROLES, type Role } from "./auth";
import { invalidateContent } from "./content";
import { siteUrl } from "@/config/site";
import { DEMO_INVITE_HOURS, DEMO_INVITE_REDIRECT, DEMO_INVITE_SUBJECT, demoInviteText } from "./demo";
import { mailConfigured, sendMail } from "./mail";
import type { Actor } from "./posts";
import { PostError } from "./posts";

function adminOnly(actor: Actor) {
  if (actor.role !== "admin") throw new PostError("Only admins can manage users.", 403);
}

export async function listUsers() {
  const db = await getDb();
  return db
    .select({ user: schema.user, profile: schema.authorProfile.slug })
    .from(schema.user)
    .leftJoin(schema.authorProfile, eq(schema.authorProfile.userId, schema.user.id))
    .orderBy(desc(schema.user.createdAt))
    .limit(500);
}

async function adminCount() {
  const db = await getDb();
  const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(schema.user).where(eq(schema.user.role, "admin"));
  return n;
}

const slugFrom = (name: string, id: string) =>
  `${name.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").slice(0, 40) || "author"}-${id.slice(0, 4).toLowerCase()}`;

/**
 * End every session of a user, wherever sessions live (Redis or Postgres). Sessions in Redis carry a copy of the
 * user, so a role change or ban only takes effect once they are gone.
 */
async function endSessions(userId: string) {
  const db = await getDb();
  await db.delete(schema.session).where(eq(schema.session.userId, userId));
  await (await (await getAuth()).$context).internalAdapter.deleteUserSessions(userId);
}

/** Change a role. Authors/admins get a public author profile if they do not have one; the user is signed out. */
export async function setRole(actor: Actor, userId: string, role: string) {
  adminOnly(actor);
  if (!ROLES.includes(role as Role)) throw new PostError("Unknown role.");
  if (userId === actor.id) throw new PostError("You cannot change your own role.");
  const db = await getDb();
  const [u] = await db.select().from(schema.user).where(eq(schema.user.id, userId));
  if (!u) throw new PostError("User not found.", 404);
  if (u.role === "admin" && role !== "admin" && (await adminCount()) <= 1) throw new PostError("There must always be at least one admin.");
  await db.update(schema.user).set({ role, updatedAt: new Date() }).where(eq(schema.user.id, userId));
  if (u.role !== role) await endSessions(userId);
  if (role === "admin" || role === "author") {
    await db.insert(schema.authorProfile).values({ userId, slug: slugFrom(u.name, u.id), displayName: u.name }).onConflictDoNothing();
  }
  await audit(actor, "user.role", userId, { from: u.role, to: role });
  invalidateContent();
}

/** Ban or unban; banning ends all of the user's sessions immediately. */
export async function setBanned(actor: Actor, userId: string, banned: boolean, reason = "") {
  adminOnly(actor);
  if (userId === actor.id) throw new PostError("You cannot ban yourself.");
  const db = await getDb();
  await db.update(schema.user).set({ banned, banReason: banned ? reason || null : null, updatedAt: new Date() }).where(eq(schema.user.id, userId));
  if (banned) await endSessions(userId);
  await audit(actor, banned ? "user.ban" : "user.unban", userId);
}

export async function deleteUser(actor: Actor, userId: string) {
  adminOnly(actor);
  if (userId === actor.id) throw new PostError("You cannot delete your own account here.");
  const db = await getDb();
  const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(schema.post).where(eq(schema.post.authorId, userId));
  if (n > 0) throw new PostError(`This user wrote ${n} post(s). Reassign or delete those posts first, or ban the account instead.`, 409);
  await db.delete(schema.user).where(eq(schema.user.id, userId));
  await audit(actor, "user.delete", userId);
  invalidateContent();
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Buffer.from(bytes).toString("base64url");
}

const inviteInput = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address.").max(254),
  name: z.string().trim().max(80).optional(),
});

export type DemoInviteResult = "invited" | "resent" | "converted";

/**
 * Invite someone to a read-only demo account (role "demo", see lib/demo.ts) by email. A new account is created
 * without a password; the email carries a set-password link (Better Auth's reset token, so /reset-password creates
 * the password login on first use). A reader with that email becomes a demo account; an admin or author is never downgraded
 * here. Inviting an existing demo account sends a fresh link.
 */
export async function inviteDemoUser(actor: Actor, raw: { email: unknown; name?: unknown }): Promise<DemoInviteResult> {
  adminOnly(actor);
  const parsed = inviteInput.safeParse({ email: raw.email, name: typeof raw.name === "string" && raw.name.trim() ? raw.name : undefined });
  if (!parsed.success) throw new PostError(parsed.error.issues[0]?.message ?? "Check the email address.");
  const { email, name } = parsed.data;
  if (!(await mailConfigured())) throw new PostError("Set up email first (Admin → Storage & email): the invitation is a set-password link sent by email.", 409);
  const db = await getDb();
  const [existing] = await db.select().from(schema.user).where(eq(schema.user.email, email));
  let id: string;
  let result: DemoInviteResult;
  if (existing) {
    if (existing.role === "admin" || existing.role === "author") throw new PostError(`${email} is already an ${existing.role}. Change the role in the table below if you really mean to make it a demo account.`, 409);
    if (existing.banned) throw new PostError(`${email} is banned. Unban it first, then invite it again.`, 409);
    id = existing.id;
    if (existing.role === "demo") result = "resent";
    else {
      await db.update(schema.user).set({ role: "demo", updatedAt: new Date() }).where(eq(schema.user.id, id));
      await endSessions(id);
      result = "converted";
    }
  } else {
    id = crypto.randomUUID();
    // Verified: the address only becomes usable through the link sent to it.
    await db.insert(schema.user).values({ id, name: name || email.split("@")[0]!, email, emailVerified: true, role: "demo" });
    result = "invited";
  }
  // The same one-time token Better Auth's "forgot password" issues (so its /reset-password endpoint accepts it and
  // creates the password login), but valid for days rather than an hour, and sent here so a failed send is seen.
  const token = randomToken();
  const ctx = await (await getAuth()).$context;
  await ctx.internalAdapter.createVerificationValue({ value: id, identifier: `reset-password:${token}`, expiresAt: new Date(Date.now() + DEMO_INVITE_HOURS * 3_600_000) });
  const url = `${ctx.baseURL}/reset-password/${token}?callbackURL=${encodeURIComponent(DEMO_INVITE_REDIRECT)}`;
  if (!(await sendMail(email, DEMO_INVITE_SUBJECT, demoInviteText(url, siteUrl())))) {
    throw new PostError(`The demo account for ${email} is ready, but the invitation email could not be sent. Check Admin → Storage & email, then press Resend invite.`, 502);
  }
  await audit(actor, result === "resent" ? "user.demo_reinvite" : "user.demo_invite", id, { email, from: existing?.role ?? null });
  return result;
}
