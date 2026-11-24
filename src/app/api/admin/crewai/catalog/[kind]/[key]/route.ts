import { z } from "zod";
import { deleteItem, duplicateItem, getItem, restoreItem, restoreVersion, setEnabled, specVersions, updateItem } from "@/lib/crewai/catalog";
import { customApiError, kindOf as catalogKind } from "@/lib/crewai/custom";
import { json, parse, SeoApiError, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

/** GET /api/admin/crewai/catalog/{crews|flows}/{key} — one crew or flow (deleted ones too) and its spec versions. */
export const GET = seoRoute<{ kind: string; key: string }>("crewai-catalog-item", {}, async (_req, _ctx, p) => {
  const kind = catalogKind(p);
  const item = await getItem(kind, p.key);
  if (!item) throw new SeoApiError("Not found.", 404, "not_found");
  return json({ item, versions: item.definition === "spec" ? await specVersions(kind, p.key) : [] });
});

const patch = z
  .object({
    label: z.string().max(120).optional(),
    description: z.string().max(1000).optional(),
    objective: z.string().max(1500).optional(),
    categories: z.array(z.string().max(40)).max(10).optional(),
    tags: z.array(z.string().max(40)).max(20).optional(),
    spec: z.record(z.string(), z.unknown()).refine((v) => JSON.stringify(v).length <= 120_000, "at most 120,000 characters of JSON").optional(),
    note: z.string().max(500).optional(),
  })
  .strict();

/** PATCH — name, description, objective, categories and tags of any crew or flow; the spec of one defined by a spec. */
export const PATCH = seoRoute<{ kind: string; key: string }>("crewai-catalog-update", { mutating: true, rate: { max: 60, windowSeconds: 600 } }, async (_req, ctx, p) => {
  const b = parse(patch, ctx.body ?? {});
  try {
    return json({ item: await updateItem(catalogKind(p), ctx.actor, p.key, b) });
  } catch (e) {
    customApiError(e);
  }
});

/** DELETE — delete (kept for its run history; restorable). A crew a flow runs is refused. */
export const DELETE = seoRoute<{ kind: string; key: string }>("crewai-catalog-delete", { mutating: true }, async (_req, ctx, p) => {
  try {
    return json(await deleteItem(catalogKind(p), ctx.actor, p.key));
  } catch (e) {
    customApiError(e);
  }
});

const action = z.discriminatedUnion("action", [
  z.object({ action: z.literal("enable") }),
  z.object({ action: z.literal("disable"), reason: z.string().max(300).optional() }),
  z.object({ action: z.literal("restore") }),
  z.object({ action: z.literal("duplicate"), key: z.string().max(40).optional(), label: z.string().max(120).optional() }),
  z.object({ action: z.literal("restore-version"), version: z.number().int().positive() }),
]);

/** POST {action: enable | disable (reason) | restore | duplicate (key, label) | restore-version (version)} — all audit-logged. */
export const POST = seoRoute<{ kind: string; key: string }>("crewai-catalog-action", { mutating: true, rate: { max: 60, windowSeconds: 600 } }, async (_req, ctx, p) => {
  const kind = catalogKind(p);
  const b = parse(action, ctx.body ?? {});
  try {
    switch (b.action) {
      case "enable":
        return json({ item: await setEnabled(kind, ctx.actor, p.key, true) });
      case "disable":
        return json({ item: await setEnabled(kind, ctx.actor, p.key, false, b.reason ?? null) });
      case "restore":
        return json({ item: await restoreItem(kind, ctx.actor, p.key) });
      case "duplicate": {
        const r = await duplicateItem(kind, ctx.actor, p.key, { key: b.key, label: b.label });
        return json(r, 201);
      }
      case "restore-version":
        return json({ item: await restoreVersion(kind, ctx.actor, p.key, b.version) });
    }
  } catch (e) {
    customApiError(e);
  }
});
