import { sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { addPrompt, suggestPrompts } from "@/lib/seo-intel/ai-visibility";
import { json, parse, seoRoute, UUID } from "@/lib/seo-intel/http";
import { enqueueSeoJob } from "@/lib/seo-intel/jobs";

export const dynamic = "force-dynamic";

const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("add"), prompt: z.string().trim().min(5).max(200) }),
  z.object({ action: z.literal("suggest"), limit: z.coerce.number().int().min(1).max(50).default(10) }),
  z.object({ action: z.literal("toggle"), id: z.string().regex(UUID), active: z.boolean() }),
  z.object({ action: z.literal("remove"), id: z.string().regex(UUID) }),
  z.object({ action: z.literal("run") }),
]);

/**
 * POST /api/admin/seo/ai-visibility — manage tracked prompts (add, add Search Console suggestions, pause, remove) and
 * queue a run now (spend still capped by the monthly budget; answers already collected today are not bought again).
 */
export const POST = seoRoute("ai-visibility", { mutating: true, rate: { max: 60, windowSeconds: 600 } }, async (_req, ctx) => {
  const b = parse(body, ctx.body);
  const db = await getDb();
  switch (b.action) {
    case "add": {
      const added = await addPrompt(db, b.prompt, "manual", ctx.actor.label);
      await ctx.audit("ai_visibility.prompt_add", undefined, { prompt: b.prompt, added });
      return json({ added }, added ? 201 : 200);
    }
    case "suggest": {
      const s = await suggestPrompts(db, b.limit);
      let added = 0;
      for (const q of s) if (await addPrompt(db, q.query, "search_console", ctx.actor.label)) added++;
      await ctx.audit("ai_visibility.prompt_suggest", undefined, { added });
      return json({ added });
    }
    case "toggle":
      await db.execute(sql`update seo_ai_prompts set active = ${b.active} where id = ${b.id}`);
      await ctx.audit("ai_visibility.prompt_toggle", b.id, { active: b.active });
      return json({ ok: true });
    case "remove":
      await db.execute(sql`delete from seo_ai_prompts where id = ${b.id}`);
      await ctx.audit("ai_visibility.prompt_remove", b.id, {});
      return json({ ok: true });
    case "run": {
      const queued = await enqueueSeoJob({ type: "ai_visibility", trigger: "manual", actor: ctx.actor.label }, "seo:ai_visibility:manual");
      await ctx.audit("ai_visibility.run", undefined, { queued });
      return json({ queued }, 202);
    }
  }
});
