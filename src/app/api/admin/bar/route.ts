import { cookies } from "next/headers";
import { isProductionEnv } from "@/config/site";
import { barCookie, readBarCookie, ADMIN_BAR_COOKIE } from "@/lib/admin-bar";
import { adminBarData } from "@/lib/admin-bar-server";
import { handleErrors } from "@/lib/http-errors";
import { getSessionUser } from "@/lib/session";

export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex", "X-Content-Type-Options": "nosniff" };

/**
 * GET /api/admin/bar?path=/blog/some-post → the admin bar's contents for the signed-in staff member and that page
 * (lib/admin-bar.ts). Anyone else gets 401 and loses the hint cookie, so their next page does not reserve the bar's
 * space. Never cached: the bar is drawn in the browser because public pages are cached for everyone.
 */
export const GET = handleErrors("admin bar", async (request: Request) => {
  const jar = await cookies();
  const hint = readBarCookie(`${ADMIN_BAR_COOKIE}=${jar.get(ADMIN_BAR_COOKIE)?.value ?? ""}`);
  const secure = isProductionEnv();
  const user = await getSessionUser();
  if (!user || (user.role !== "admin" && user.role !== "author")) {
    const headers = new Headers(HEADERS);
    if (jar.has(ADMIN_BAR_COOKIE)) headers.append("Set-Cookie", barCookie(null, secure));
    return Response.json({ user: null }, { status: 401, headers });
  }
  const raw = new URL(request.url).searchParams.get("path") ?? "/";
  const path = raw.startsWith("/") && !raw.startsWith("//") && raw.length <= 512 ? raw : "/";
  const preference = hint ?? "on";
  const data = await adminBarData(user, path, preference);
  const headers = new Headers(HEADERS);
  // First time this browser sees the bar: remember it, so later pages reserve its space before the first paint.
  if (!hint) headers.append("Set-Cookie", barCookie("on", secure));
  return Response.json(data, { headers });
});
