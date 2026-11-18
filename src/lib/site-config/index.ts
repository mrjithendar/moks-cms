import { cache } from "react";
import { getSessionUser } from "../session";
import { getDraftConfig, getPublishedConfig, isConfigPreviewValid, PREVIEW_COOKIE } from "./store";
import type { SiteConfig } from "./schema";

export type ResolvedConfig = { config: SiteConfig; preview: boolean };

/**
 * The configuration for the current request: the published one, or the private draft when the viewer is an
 * admin with a valid preview token (cookie set by /api/admin/appearance/preview, together with Next's draft mode,
 * which bypasses the ISR page cache for that browser only). Memoised per request.
 * Only pages and layouts call this; library code (auth, comments…) uses the published config.
 */
export const getSiteConfig = cache(async (): Promise<ResolvedConfig> => {
  const token = await previewToken();
  if (token) {
    const user = await getSessionUser().catch(() => null);
    if (user?.role === "admin" && (await isConfigPreviewValid(token, user.id))) return { config: await getDraftConfig(), preview: true };
  }
  return { config: (await getPublishedConfig()).config, preview: false };
});

async function previewToken(): Promise<string | undefined> {
  try {
    const { cookies, draftMode } = await import("next/headers");
    // Draft mode is on only for the admin who opened a preview (/api/admin/appearance/preview). Checking it first
    // keeps every other request static: reading cookies() would make each page render per request (no ISR).
    if (!(await draftMode()).isEnabled) return undefined;
    return (await cookies()).get(PREVIEW_COOKIE)?.value;
  } catch {
    return undefined; // outside a request (build, scripts)
  }
}

export { PREVIEW_COOKIE };
