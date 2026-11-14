import { revalidatePath } from "next/cache";
import { askEnabled } from "@/lib/seo-agent/config";
import { DEFAULT_ASK_SETTINGS, getAskSettings, loadAskStatus, saveAskSettings } from "@/lib/seo-agent/ask-settings";
import { json, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

/** GET /api/admin/seo/ask-blog — the saved Ask the Blog settings, the defaults, the environment switch and the status numbers. */
export const GET = seoRoute("ask-blog", {}, async () => json({ settings: await getAskSettings(), defaults: DEFAULT_ASK_SETTINGS, envEnabled: askEnabled(), status: await loadAskStatus() }));

/**
 * PUT /api/admin/seo/ask-blog — validate and save the whole document; audit-logged with before/after. Public pages are
 * revalidated so the widget appears, disappears or changes its text without waiting for the page cache; /api/ask reads
 * the setting on every request, and the seo-agent picks it up within its cache window (about 30 seconds).
 */
export const PUT = seoRoute("ask-blog-put", { mutating: true, rate: { max: 20, windowSeconds: 600 } }, async (_req, ctx) => {
  const { before, after } = await saveAskSettings(ctx.body, ctx.actor.id);
  await ctx.audit("ask_blog.update", "ask_blog", { before, after });
  revalidatePath("/", "layout");
  return json({ settings: after });
});
