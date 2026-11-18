import { json, seoRoute } from "@/lib/seo-intel/http";
import { createSkill, listSkills } from "@/lib/seo-agent/skills";

export const dynamic = "force-dynamic";

/** GET — every skill (the defaults are inserted first if missing). */
export const GET = seoRoute("skills", {}, async () => json({ skills: await listSkills() }));

/** POST — add an admin's own skill. */
export const POST = seoRoute("skill-create", { mutating: true }, async (_req, ctx) => json({ skill: await createSkill(ctx.actor, ctx.body ?? {}) }, 201));
