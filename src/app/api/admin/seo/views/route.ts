import { sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { rowsOf } from "@/db/rows";
import { json, parse, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

const PAGES = ["keywords", "review", "content", "links"] as const;
const body = z.object({ page: z.enum(PAGES), name: z.string().trim().min(1).max(60), params: z.record(z.string().max(40), z.string().max(200)).refine((o) => Object.keys(o).length <= 30) });
const del = z.object({ page: z.enum(PAGES), name: z.string().trim().min(1).max(60) });

/** GET /api/admin/seo/views?page=keywords — saved views (named filter/sort/column sets). */
export const GET = seoRoute("views-list", {}, async (_req, ctx) => {
  const page = PAGES.find((p) => p === ctx.query.get("page")) ?? "keywords";
  return json(rowsOf(await (await getDb()).execute(sql`select name, params from seo_saved_views where page = ${page} order by name`)));
});

/** POST — save (or overwrite) a view. DELETE — remove one. */
export const POST = seoRoute("views-save", { mutating: true }, async (_req, ctx) => {
  const b = parse(body, ctx.body);
  await (await getDb()).execute(sql`insert into seo_saved_views (page, name, params, created_by) values (${b.page}, ${b.name}, ${JSON.stringify(b.params)}::jsonb, ${ctx.actor.label}) on conflict (page, name) do update set params = excluded.params`);
  await ctx.audit("views.save", b.page, { name: b.name });
  return json({ ok: true });
});
export const DELETE = seoRoute("views-delete", { mutating: true }, async (req, ctx) => {
  const u = new URL(req.url).searchParams;
  const b = parse(del, { page: u.get("page"), name: u.get("name") });
  await (await getDb()).execute(sql`delete from seo_saved_views where page = ${b.page} and name = ${b.name}`);
  await ctx.audit("views.delete", b.page, { name: b.name });
  return json({ ok: true });
});
