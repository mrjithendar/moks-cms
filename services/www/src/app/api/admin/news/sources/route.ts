import { json, seoRoute } from "@/lib/seo-intel/http";
import { credibilitySuggestions, listSources, saveSource } from "@/lib/news/service";

export const dynamic = "force-dynamic";

export const GET = seoRoute("news-sources", {}, async () => json({ sources: await listSources(), suggestions: await credibilitySuggestions() }));
/** POST — add a source, or {action: "import_starters"} to add the verified starter list (all disabled). */
export const POST = seoRoute("news-sources-create", { mutating: true }, async (_req, ctx) => {
  if ((ctx.body as { action?: string } | undefined)?.action === "import_starters") {
    const { importStarterSources } = await import("@/lib/news/starter-sources");
    return json(await importStarterSources(ctx.actor), 201);
  }
  return json(await saveSource(ctx.actor, null, ctx.body), 201);
});
