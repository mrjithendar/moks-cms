import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, type Db } from "@/db";
import type { Actor } from "@/lib/posts";
import { freshDb } from "./db-helpers";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

// The request as the app sees it after the proxy: the cookie, the stamped method, the referer.
let request: Record<string, string> = {};
vi.mock("next/headers", () => ({
  headers: async () => new Headers(request),
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {}, delete: () => {}, has: () => false }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error(`REDIRECT ${url}`), { digest: `NEXT_REDIRECT;${url}` });
  },
}));

// Mail is "configured" and every message is captured (no real provider in tests).
const sent: { to: string; subject: string; text: string }[] = [];
let mailOn = true;
let mailWorks = true;
vi.mock("@/lib/mail", async (orig) => ({
  ...(await orig<typeof import("@/lib/mail")>()),
  mailConfigured: async () => mailOn,
  sendMail: async (to: string, subject: string, text: string) => {
    if (!mailWorks) return false;
    sent.push({ to, subject, text });
    return true;
  },
}));

const ORIGIN = "https://jithendar.com";
const realFetch = globalThis.fetch;
const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.startsWith("https://challenges.cloudflare.com/")) return new Response(JSON.stringify({ success: true }), { headers: { "content-type": "application/json" } });
  if (url.startsWith("https://api.pwnedpasswords.com/")) return new Response("", { status: 200 });
  return realFetch(input, init);
});

const admin: Actor = { id: "admin", role: "admin", label: "admin@example.com" };
const PASSWORD = "Demo-account-passphrase-2026";
let db: Db;
type Auth = Awaited<ReturnType<typeof import("@/lib/auth").getAuth>>;
let auth: Auth;

async function authPost(path: string, body: unknown, cookie = "") {
  return auth.handler(
    new Request(`${ORIGIN}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, "x-captcha-response": "ok", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    }),
  );
}

function sessionCookie(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((line) => line.split(";")[0]!)
    .filter((pair) => pair.includes("session_token=") && !pair.endsWith("="))
    .join("; ");
}

/** Invite, follow the emailed link to set a password, sign in: the session cookie of a real demo account. */
async function acceptInvite(email: string): Promise<string> {
  const { inviteDemoUser } = await import("@/lib/users");
  await inviteDemoUser(admin, { email });
  const mail = sent.findLast((m) => m.to === email)!;
  const link = new URL(/https?:\/\/\S+/.exec(mail.text)![0]);
  const token = link.pathname.split("/").pop()!;
  const reset = await authPost("/reset-password", { newPassword: PASSWORD, token });
  expect(reset.status).toBe(200);
  const signIn = await authPost("/sign-in/email", { email, password: PASSWORD });
  expect(signIn.status).toBe(200);
  return sessionCookie(signIn);
}

const as = (cookie: string, method: string, extra: Record<string, string> = {}) => {
  request = { cookie, "x-moks-request-method": method, ...extra };
};

beforeAll(() => {
  vi.stubGlobal("fetch", fakeFetch);
  process.env.TURNSTILE_SECRET_KEY = "test-turnstile";
  process.env.BETTER_AUTH_SECRET = "test-secret-0123456789abcdef0123456789abcdef";
});
afterAll(() => vi.unstubAllGlobals());

beforeEach(async () => {
  db = await freshDb();
  const { broadcastInvalidate } = await import("@/lib/cache-bus");
  broadcastInvalidate("settings");
  (globalThis as { __auth?: unknown }).__auth = undefined;
  auth = await (await import("@/lib/auth")).getAuth();
  await db.insert(schema.user).values({ id: "admin", name: "Admin", email: "admin@example.com", emailVerified: true, role: "admin" });
  sent.length = 0;
  mailOn = true;
  mailWorks = true;
  request = {};
});

describe("request classification", () => {
  it("counts only proxy-stamped GET/HEAD without a server-action header as a read", async () => {
    const { isReadRequest } = await import("@/lib/demo");
    const h = (o: Record<string, string>) => new Headers(o);
    expect(isReadRequest(h({ "x-moks-request-method": "GET" }))).toBe(true);
    expect(isReadRequest(h({ "x-moks-request-method": "HEAD" }))).toBe(true);
    expect(isReadRequest(h({ "x-moks-request-method": "POST" }))).toBe(false);
    expect(isReadRequest(h({ "x-moks-request-method": "DELETE" }))).toBe(false);
    expect(isReadRequest(h({}))).toBe(false); // no stamp: fail closed
    expect(isReadRequest(h({ "x-moks-request-method": "GET", "next-action": "abc" }))).toBe(false);
  });

  it("the proxy stamps the real method, overwriting whatever the client sent", async () => {
    const { NextRequest } = await import("next/server");
    const { proxy } = await import("@/proxy");
    const res = await proxy(new NextRequest(`${ORIGIN}/admin/posts`, { method: "POST", headers: { "x-moks-request-method": "GET", host: "jithendar.com" } }));
    expect(res.headers.get("x-middleware-request-x-moks-request-method")).toBe("POST");
  });

  it("sends a refused write back to the admin page it came from, never to another site", async () => {
    const { demoDeniedTarget, DEMO_READ_ONLY_MESSAGE } = await import("@/lib/demo");
    const msg = encodeURIComponent(DEMO_READ_ONLY_MESSAGE);
    expect(demoDeniedTarget(`${ORIGIN}/admin/users?ok=Saved.&page=2`)).toBe(`/admin/users?page=2&error=${msg}`);
    expect(demoDeniedTarget("https://evil.example/admin/x")).toBe(`/admin/x?error=${msg}`);
    expect(demoDeniedTarget("https://evil.example/phish")).toBe(`/admin?error=${msg}`);
    expect(demoDeniedTarget(null)).toBe(`/admin?error=${msg}`);
  });
});

describe("demo invitations", () => {
  it("create a demo account and email a set-password link worded as an invitation", async () => {
    const { inviteDemoUser } = await import("@/lib/users");
    expect(await inviteDemoUser(admin, { email: " Prospect@Example.com ", name: "Pat" })).toBe("invited");
    const [u] = await db.select().from(schema.user).where(eq(schema.user.email, "prospect@example.com"));
    expect(u).toMatchObject({ role: "demo", name: "Pat", emailVerified: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe("Your invitation to the Jithendar.com CMS demo");
    expect(sent[0]!.text).toContain("read-only demo");
    expect(sent[0]!.text).toContain("/api/auth/reset-password/");
    // No public author profile for a demo account.
    expect(await db.select().from(schema.authorProfile).where(eq(schema.authorProfile.userId, u!.id))).toHaveLength(0);
    const [entry] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "user.demo_invite"));
    expect(entry).toBeTruthy();
  });

  it("let the invitee set a password and sign in (the password login is created on first use)", async () => {
    const cookie = await acceptInvite("prospect@example.com");
    expect(cookie).toContain("session_token=");
    const [u] = await db.select().from(schema.user).where(eq(schema.user.email, "prospect@example.com"));
    const accounts = await db.select().from(schema.account).where(eq(schema.account.userId, u!.id));
    expect(accounts.map((a) => a.providerId)).toEqual(["credential"]);
  });

  it("resend to an existing demo account, convert a reader, and never downgrade an admin or author", async () => {
    const { inviteDemoUser } = await import("@/lib/users");
    await inviteDemoUser(admin, { email: "prospect@example.com" });
    expect(await inviteDemoUser(admin, { email: "prospect@example.com" })).toBe("resent");
    await db.insert(schema.user).values([
      { id: "reader", name: "R", email: "reader@example.com", role: "user" },
      { id: "author", name: "A", email: "author@example.com", role: "author" },
      { id: "gone", name: "G", email: "banned@example.com", role: "user", banned: true },
    ]);
    expect(await inviteDemoUser(admin, { email: "reader@example.com" })).toBe("converted");
    expect((await db.select().from(schema.user).where(eq(schema.user.id, "reader")))[0]!.role).toBe("demo");
    await expect(inviteDemoUser(admin, { email: "author@example.com" })).rejects.toMatchObject({ status: 409 });
    await expect(inviteDemoUser(admin, { email: "admin@example.com" })).rejects.toMatchObject({ status: 409 });
    await expect(inviteDemoUser(admin, { email: "banned@example.com" })).rejects.toMatchObject({ status: 409 });
    expect((await db.select().from(schema.user).where(eq(schema.user.id, "author")))[0]!.role).toBe("author");
  });

  it("are admin-only, validate the email, need email set up, and report a failed send", async () => {
    const { inviteDemoUser } = await import("@/lib/users");
    await expect(inviteDemoUser({ id: "a", role: "author", label: "a" }, { email: "x@example.com" })).rejects.toMatchObject({ status: 403 });
    await expect(inviteDemoUser(admin, { email: "not-an-email" })).rejects.toThrow("valid email");
    mailOn = false;
    await expect(inviteDemoUser(admin, { email: "x@example.com" })).rejects.toThrow("Set up email first");
    expect(await db.select().from(schema.user).where(eq(schema.user.email, "x@example.com"))).toHaveLength(0);
    mailOn = true;
    mailWorks = false;
    await expect(inviteDemoUser(admin, { email: "y@example.com" })).rejects.toMatchObject({ status: 502 });
  });

  it("link to the invitation wording of the reset page and work for days, not an hour", async () => {
    const { inviteDemoUser } = await import("@/lib/users");
    await inviteDemoUser(admin, { email: "prospect@example.com" });
    const link = new URL(/https?:\/\/\S+/.exec(sent[0]!.text)![0]);
    expect(link.searchParams.get("callbackURL")).toBe("/reset-password?invite=demo");
    const [v] = await db.select().from(schema.verification);
    expect(v!.expiresAt.getTime() - Date.now()).toBeGreaterThan(71 * 3_600_000);
    // Following the link lands on the reset page with the token (Better Auth checks it first).
    const res = await auth.handler(new Request(`${ORIGIN}${link.pathname}${link.search}`));
    expect(new URL(res.headers.get("location")!, ORIGIN).searchParams.get("invite")).toBe("demo");
  });
});

describe("a signed-in demo account", () => {
  it("is an admin while reading and refused on every write", async () => {
    const cookie = await acceptInvite("prospect@example.com");
    const { getSessionUser, requireRole } = await import("@/lib/session");

    as(cookie, "GET");
    expect(await getSessionUser()).toMatchObject({ role: "admin", demo: true });
    expect(await requireRole("admin")).toMatchObject({ role: "admin", demo: true });

    // A server action (always a POST): back to the page it came from with the read-only notice.
    as(cookie, "POST", { "next-action": "abc", referer: `${ORIGIN}/admin/users` });
    expect(await getSessionUser()).toMatchObject({ role: "demo", demo: true });
    await expect(requireRole("admin")).rejects.toThrow("REDIRECT /admin/users?error=");
    await expect(requireRole("admin", "author")).rejects.toThrow("REDIRECT /admin/users?error=");

    // No proxy stamp at all counts as a write.
    as(cookie, "");
    expect(await getSessionUser()).toMatchObject({ role: "demo" });
  });

  it("is refused by the editor, the admin APIs, comments and backup download", async () => {
    const cookie = await acceptInvite("prospect@example.com");
    const { editorActor } = await import("@/lib/admin");
    const { seoRoute, json } = await import("@/lib/seo-intel/http");
    const read = seoRoute("demo-read", {}, async () => json({ ok: true }));
    const write = seoRoute("demo-write", { mutating: true }, async () => json({ ok: true }));

    as(cookie, "POST");
    await expect(editorActor()).rejects.toMatchObject({ status: 403, message: expect.stringContaining("read-only demo") });
    const refused = await write(new Request(`${ORIGIN}/api/admin/seo/x`, { method: "POST", headers: { origin: ORIGIN } }));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "demo_read_only" });

    const { submitComment, editComment } = await import("@/lib/comments");
    const { getSessionUser } = await import("@/lib/session");
    const me = (await getSessionUser())!;
    await expect(submitComment(me, { postId: "00000000-0000-0000-0000-000000000000", body: "hi" } as never)).rejects.toMatchObject({ status: 403 });
    await expect(editComment(me, "c1", "hi")).rejects.toMatchObject({ status: 403 });

    as(cookie, "GET");
    expect((await read(new Request(`${ORIGIN}/api/admin/seo/x`))).status).toBe(200);
    const { GET: backup } = await import("@/app/api/admin/backup/route");
    expect((await backup(new Request(`${ORIGIN}/api/admin/backup`))).status).toBe(403);
  });

  it("loses access as soon as an admin changes its role or bans it", async () => {
    const { getSessionUser } = await import("@/lib/session");
    const { setBanned, setRole } = await import("@/lib/users");

    const first = await acceptInvite("prospect@example.com");
    const [u] = await db.select().from(schema.user).where(eq(schema.user.email, "prospect@example.com"));
    as(first, "GET");
    expect(await getSessionUser()).toMatchObject({ demo: true });
    await setRole(admin, u!.id, "user");
    expect(await getSessionUser()).toBeNull();

    await setRole(admin, u!.id, "demo");
    const signIn = await authPost("/sign-in/email", { email: "prospect@example.com", password: PASSWORD });
    as(sessionCookie(signIn), "GET");
    expect(await getSessionUser()).toMatchObject({ demo: true });
    await setBanned(admin, u!.id, true);
    expect(await getSessionUser()).toBeNull();
  });
});
