import { z } from "zod";
import { createItem, listCatalog, parseFilter } from "@/lib/crewai/catalog";
import { customApiError, kindOf as catalogKind } from "@/lib/crewai/custom";
import { json, parse, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/crewai/catalog/{crews|flows}?q&category&tag&status&recent&run&sort&dir&page&size — one page of crews or
 * flows, server-side filtered and sorted, with the total and per-category and per-tag counts (lib/crewai/catalog.ts).
 */
export const GET = seoRoute<{ kind: string }>("crewai-catalog-list", {}, async (req, _ctx, p) => json(await listCatalog(catalogKind(p), parseFilter(new URL(req.url).searchParams))));

const create = z
  .object({
    key: z.string().max(40),
    label: z.string().max(120),
    description: z.string().max(1000).optional(),
    objective: z.string().max(1500).optional(),
    categories: z.array(z.string().max(40)).max(10).optional(),
    tags: z.array(z.string().max(40)).max(20).optional(),
    enabled: z.boolean().optional(),
    spec: z.record(z.string(), z.unknown()).refine((v) => JSON.stringify(v).length <= 120_000, "at most 120,000 characters of JSON"),
    note: z.string().max(500).optional(),
  })
  .strict();

/** POST /api/admin/crewai/catalog/{crews|flows} — a new crew or flow defined by a spec (the SEO agent checks it: 422 + issues). */
export const POST = seoRoute<{ kind: string }>("crewai-catalog-create", { mutating: true, rate: { max: 30, windowSeconds: 600 } }, async (_req, ctx, p) => {
  const b = parse(create, ctx.body ?? {});
  try {
    return json({ item: await createItem(catalogKind(p), ctx.actor, b) }, 201);
  } catch (e) {
    customApiError(e);
  }
});
