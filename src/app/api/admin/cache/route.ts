import { z } from "zod";
import { CACHE_ACTIONS } from "@/lib/admin-bar";
import { runCacheAction } from "@/lib/cache-admin";
import { json, parse, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

const Body = z.object({ action: z.enum(CACHE_ACTIONS), path: z.string().max(512).optional() });

/**
 * POST /api/admin/cache {action, path?} → { message }. The admin bar's Cache menu (lib/cache-admin.ts).
 * Admins only, same-origin JSON, rate-limited and audit-logged (seoRoute); the read-only demo gets 403.
 */
export const POST = seoRoute("cache", { mutating: true }, async (_req, ctx) => {
  const body = parse(Body, ctx.body);
  return json({ message: await runCacheAction(ctx.actor, body.action, body.path) });
});
