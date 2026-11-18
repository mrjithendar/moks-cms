import { json, seoRoute } from "@/lib/seo-intel/http";
import { resetSkill } from "@/lib/seo-agent/skills";

export const dynamic = "force-dynamic";

/** POST — put a default skill back to the shipped text, agents and tags. */
export const POST = seoRoute<{ id: string }>("skill-reset", { mutating: true }, async (_req, ctx, p) => json({ skill: await resetSkill(ctx.actor, p.id) }));
