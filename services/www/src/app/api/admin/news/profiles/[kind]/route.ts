import { z } from "zod";
import { json, parse, SeoApiError, seoRoute } from "@/lib/seo-intel/http";
import { activateProfile, listProfiles, saveProfile } from "@/lib/news/service";

export const dynamic = "force-dynamic";
const kind = (k: string) => {
  if (k !== "writing" && k !== "image") throw new SeoApiError("Unknown profile kind.", 404, "not_found");
  return k;
};
const body = z.object({ profile: z.record(z.string(), z.unknown()), activate: z.boolean().default(false) });
const act = z.object({ key: z.string().max(42), version: z.number().int().min(1) });

export const GET = seoRoute<{ kind: string }>("news-profiles", {}, async (_req, _ctx, p) => json({ profiles: await listProfiles(kind(p.kind)) }));
/** POST — save a new version (optionally active). */
export const POST = seoRoute<{ kind: string }>("news-profile-save", { mutating: true }, async (_req, ctx, p) => {
  const b = parse(body, ctx.body ?? {});
  return json(await saveProfile(ctx.actor, kind(p.kind), b.profile, b.activate), 201);
});
/** PUT — activate a version (also how a proposed style-review version is approved). */
export const PUT = seoRoute<{ kind: string }>("news-profile-activate", { mutating: true }, async (_req, ctx, p) => {
  const b = parse(act, ctx.body ?? {});
  await activateProfile(ctx.actor, kind(p.kind), b.key, b.version);
  return json({ ok: true });
});
