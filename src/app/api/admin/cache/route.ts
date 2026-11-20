import { z } from "zod";
import { CACHE_ACTIONS } from "@/lib/admin-bar";
import { runCacheAction } from "@/lib/cache-admin";
import { json, parse, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

const Body = z.object({
  action: z.enum(CACHE_ACTIONS),
  path: z.string().max(512).optional(),
  kind: z.string().max(20).optional(),
  items: z.string().max(200_000).optional(),
});

/**
 * POST /api/admin/cache {action, path?, kind?, items?} → { message } (lib/cache-admin.ts): the admin bar's Cache menu.
 * 200 when everything was purged; 502 when the site's caches were cleared but Cloudflare refused (the message says
 * why). Admins only, same-origin JSON, rate-limited and audit-logged (seoRoute); the read-only demo gets 403.
 */
export const POST = seoRoute("cache", { mutating: true }, async (_req, ctx) => {
  const { action, ...input } = parse(Body, ctx.body);
  const result = await runCacheAction(ctx.actor, action, input);
  return json({ message: result.message }, result.ok ? 200 : 502);
});
