import { json, seoRoute } from "@/lib/seo-intel/http";
import { deleteSkill, updateSkill } from "@/lib/seo-agent/skills";

export const dynamic = "force-dynamic";

/** PATCH — edit a skill's description, instructions, agents or tags, or enable/disable it. */
export const PATCH = seoRoute<{ id: string }>("skill-update", { mutating: true }, async (_req, ctx, p) => json({ skill: await updateSkill(ctx.actor, p.id, ctx.body ?? {}) }));

/** DELETE — remove an admin's own skill (a default can only be disabled). */
export const DELETE = seoRoute<{ id: string }>("skill-delete", { mutating: true }, async (_req, ctx, p) => {
  await deleteSkill(ctx.actor, p.id);
  return json({ ok: true });
});
