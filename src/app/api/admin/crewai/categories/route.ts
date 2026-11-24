import { z } from "zod";
import { createCategory, listCategories } from "@/lib/crewai/catalog";
import { customApiError } from "@/lib/crewai/custom";
import { json, parse, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

/** GET /api/admin/crewai/categories — every category, with how many crews and flows are filed under it. */
export const GET = seoRoute("crewai-categories", {}, async () => json({ items: await listCategories() }));

/** POST {label, slug?, description?} — a new category (organisation only: it never changes how anything runs). */
export const POST = seoRoute("crewai-category-create", { mutating: true, rate: { max: 30, windowSeconds: 600 } }, async (_req, ctx) => {
  const b = parse(z.object({ label: z.string().max(60), slug: z.string().max(40).optional(), description: z.string().max(300).optional(), position: z.number().int().optional() }).strict(), ctx.body ?? {});
  try {
    return json({ item: await createCategory(ctx.actor, b) }, 201);
  } catch (e) {
    customApiError(e);
  }
});
