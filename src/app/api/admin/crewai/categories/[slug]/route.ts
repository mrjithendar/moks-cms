import { z } from "zod";
import { deleteCategory, updateCategory } from "@/lib/crewai/catalog";
import { customApiError } from "@/lib/crewai/custom";
import { json, parse, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

/** PATCH {label?, description?, position?} — rename (the slug stays, so nothing filed under it moves), describe or reorder. */
export const PATCH = seoRoute<{ slug: string }>("crewai-category-update", { mutating: true }, async (_req, ctx, p) => {
  const b = parse(z.object({ label: z.string().max(60).optional(), description: z.string().max(300).optional(), position: z.number().int().optional() }).strict(), ctx.body ?? {});
  try {
    return json({ item: await updateCategory(ctx.actor, p.slug, b) });
  } catch (e) {
    customApiError(e);
  }
});

/** DELETE — remove the category; it is taken off every crew and flow filed under it. */
export const DELETE = seoRoute<{ slug: string }>("crewai-category-delete", { mutating: true }, async (_req, ctx, p) => {
  try {
    return json(await deleteCategory(ctx.actor, p.slug));
  } catch (e) {
    customApiError(e);
  }
});
