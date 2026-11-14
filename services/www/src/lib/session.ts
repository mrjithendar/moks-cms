import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth, ROLES, type Role } from "./auth";
import { demoDeniedTarget, isReadRequest } from "./demo";

/**
 * `role` is the role in effect for this request. A demo account (`demo: true`) is "admin" while it only reads and
 * "demo" on a write, which no staff check accepts (lib/demo.ts).
 */
export type SessionUser = { id: string; name: string; email: string; role: Role; emailVerified: boolean; image: string | null; sessionCreatedAt: Date; demo?: true };

export async function getSessionUser(): Promise<SessionUser | null> {
  const auth = await getAuth();
  const h = await headers();
  const session = await auth.api.getSession({ headers: h });
  if (!session) return null;
  const u = session.user as typeof session.user & { role?: string; banned?: boolean | null };
  if (u.banned) return null;
  const stored = ROLES.includes(u.role as Role) ? (u.role as Role) : "user";
  const base = { id: u.id, name: u.name, email: u.email, emailVerified: u.emailVerified, image: u.image ?? null, sessionCreatedAt: new Date(session.session.createdAt) };
  if (stored === "demo") return { ...base, role: isReadRequest(h) ? "admin" : "demo", demo: true };
  return { ...base, role: stored };
}

/**
 * Whether the browser still sends a session cookie the server no longer accepts (expired, revoked or signed out
 * elsewhere), as opposed to never having signed in. Better Auth deletes the cookie on sign-out.
 */
async function hasStaleSessionCookie(): Promise<boolean> {
  return (await cookies()).getAll().some((c) => c.name.endsWith("session_token") && c.value !== "");
}

/** The sign-in URL for a private page; says "session expired" only when there was a session. */
async function signInRedirect(next: string): Promise<never> {
  redirect(`/login?next=${encodeURIComponent(next)}${(await hasStaleSessionCookie()) ? "&expired=1" : ""}`);
}

/** Server components and actions: require one of the roles, otherwise send to /login. */
export async function requireRole(...roles: Role[]): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) return signInRedirect("/admin");
  // A demo account trying to save: back to the page it was on, with the read-only notice.
  if (user.demo && !roles.includes(user.role)) redirect(demoDeniedTarget((await headers()).get("referer")));
  if (!roles.includes(user.role)) redirect("/account?denied=1");
  return user;
}

/** Any signed-in user (account pages); otherwise to /login, returning to `next` afterwards. */
export async function requireUser(next: string): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) return signInRedirect(next);
  return user;
}

/** Whether the session is recent enough for sensitive account changes (Better Auth's freshAge). */
export function isFreshSession(user: SessionUser, freshSeconds: number, now = Date.now()): boolean {
  return now - user.sessionCreatedAt.getTime() < freshSeconds * 1000;
}
