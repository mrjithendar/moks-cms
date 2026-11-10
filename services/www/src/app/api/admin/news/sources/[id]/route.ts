import { json, SeoApiError, seoRoute, UUID } from "@/lib/seo-intel/http";
import { testSources } from "@/lib/news/agent";
import { deleteSource, saveSource } from "@/lib/news/service";

export const dynamic = "force-dynamic";
const id = (v: string) => {
  if (!UUID.test(v)) throw new SeoApiError("Source not found.", 404, "not_found");
  return v;
};

export const PUT = seoRoute<{ id: string }>("news-source-save", { mutating: true }, async (_req, ctx, p) => json(await saveSource(ctx.actor, id(p.id), ctx.body)));
export const DELETE = seoRoute<{ id: string }>("news-source-delete", { mutating: true }, async (_req, ctx, p) => {
  await deleteSource(ctx.actor, id(p.id));
  return json({ ok: true });
});
/** POST — "Test source": fetch it now (ingest flow for this source only); the run detail shows the result. */
export const POST = seoRoute<{ id: string }>("news-source-test", { mutating: true, rate: { max: 10, windowSeconds: 60 } }, async (_req, ctx, p) => json(await testSources([id(p.id)], ctx.actor.label), 202));
