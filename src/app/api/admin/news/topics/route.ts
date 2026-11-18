import { z } from "zod";
import { json, parse, seoRoute } from "@/lib/seo-intel/http";
import { train } from "@/lib/news/agent";
import { listTopics, saveTopic } from "@/lib/news/service";

export const dynamic = "force-dynamic";
const topic = z.object({ slug: z.string().max(61), label: z.string().min(1).max(120), category_slug: z.string().max(60).nullable(), keywords: z.array(z.string().max(80)).max(50).default([]), tags: z.array(z.string().max(60)).max(20).default([]), enabled: z.boolean().default(true) });
const trainBody = z.object({ retrain: z.literal(true), bootstrap: z.boolean().default(false) });

export const GET = seoRoute("news-topics", {}, async () => json({ topics: await listTopics() }));
export const PUT = seoRoute("news-topic-save", { mutating: true }, async (_req, ctx) => {
  await saveTopic(ctx.actor, parse(topic, ctx.body ?? {}));
  return json({ ok: true });
});
/** POST {retrain: true, bootstrap?} — retrain the classifier (and ranker) now; bootstrap labels ~1,000 items with Claude once. */
export const POST = seoRoute("news-train", { mutating: true, rate: { max: 3, windowSeconds: 300 } }, async (_req, ctx) => {
  const b = parse(trainBody, ctx.body ?? {});
  return json(await train(b.bootstrap, ctx.actor.label), 202);
});
