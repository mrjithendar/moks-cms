/**
 * News desk E2E / screenshot seed — LOCAL PGlite ONLY (refuses DATABASE_URL and production). Run after e2e-seed.ts.
 * Everything here is invented demo data (labelled "Demo"), not real news: a job, the verified starter sources (disabled
 * except two), one finished run with its timeline, log lines and scored candidates, and one news draft created through
 * the real callback path (CMS draft post + review draft). The cover is a real template cover rendered by seo-agent,
 * passed as a data URL for display only (no media storage locally).
 *
 *   NODE_OPTIONS=--conditions=react-server PGLITE_DIR=/tmp/e2e-db NEWS_COVER_B64="$(cat cover.b64)" npx tsx scripts/news-e2e-seed.ts
 */
if (process.env.DATABASE_URL || process.env.APP_ENV === "production") {
  console.error("Refusing: the news E2E seed is for a local PGlite database only.");
  process.exit(1);
}
const { sql } = await import("drizzle-orm");
const { getDb } = await import("../src/db");
const { rowsOf } = await import("../src/db/rows");
const svc = await import("../src/lib/news/service");
const { importStarterSources } = await import("../src/lib/news/starter-sources");
const { newsSaveDraft } = await import("../src/lib/news/callbacks");

const db = await getDb();
const [admin] = rowsOf<{ id: string }>(await db.execute(sql`select id from "user" where role = 'admin' order by created_at limit 1`));
if (!admin) throw new Error("run scripts/e2e-seed.ts first");
const actor = { id: admin.id, role: "admin" as const, label: "e2e-admin@example.com" };
const [existing] = rowsOf<{ id: string }>(await db.execute(sql`select id from news_jobs where name like 'Demo ·%' and deleted_at is null limit 1`));
if (existing) {
  console.log(`News demo data already seeded (job ${existing.id}).`);
  process.exit(0);
}
await svc.ensureNewsDefaults(db);
await importStarterSources(actor);
await db.execute(sql`update news_sources set enabled = true where url in ('https://kubernetes.io/feed.xml', 'https://api.github.com/repos/kubernetes/kubernetes/releases?per_page=10')`);
await db.execute(sql`update news_sources set last_fetch_at = now() - interval '40 minutes', last_success_at = now() - interval '40 minutes', last_status = 'ok', fetch_count = 12, avg_items = 8.5, items_total = 41 where enabled`);
await db.execute(sql`update news_sources set last_fetch_at = now() - interval '2 hours', last_status = 'error: robots.txt of www.hashicorp.com does not allow fetching /blog/feed.xml.', error_count = 3, consecutive_errors = 3, fetch_count = 9 where url = 'https://www.hashicorp.com/blog/feed.xml'`);
await db.execute(sql`update news_topics set keywords = '{kubernetes,kubelet,pod,kubectl,helm}', tags = '{kubernetes}' where slug = 'kubernetes'`);

const job = (await svc.createJob(actor, { name: "Demo · Cloud native daily", description: "Kubernetes and CNCF releases worth a note (demo job).", enabled: false, cron: "0 7 * * 1-5", timezone: "Asia/Kolkata", config: { topics: ["kubernetes"], max_articles_per_run: 2, publishing_slots: ["09:00", "17:30"], expiry_days: 30 } }))!;
await svc.updateJob(actor, job.id, { name: job.name, description: job.description, enabled: false, cron: job.cron, timezone: job.timezone, mode: "single_stories", writing_profile_key: "news-default", image_profile_key: "cover-template", review_priority: 60, config: { ...job.config, min_score: 0.4 } });

const runId = crypto.randomUUID();
await db.execute(sql`insert into news_runs (id, job_id, job_version, kind, trigger, status, counters, tokens, cost_usd, started_at, finished_at)
  values (${runId}, ${job.id}, 2, 'job', 'manual', 'succeeded', ${JSON.stringify({ fetched: 18, new: 11, deduped: 3, clustered: 7, scored: 4, selected: 1, drafted: 1, source_errors: 1 })}::jsonb, 84210, 0.2391, now() - interval '25 minutes', now() - interval '21 minutes')`);
const steps: [string, number, number, number][] = [["fetch", 3, 11, 6.2], ["dedupe", 11, 7, 0.4], ["classify", 7, 7, 1.1], ["score", 0, 4, 0.2], ["select", 4, 1, 0.1], ["draft", 2, 1, 142.0], ["quality", 0, 1, 0.9], ["image", 0, 1, 3.4], ["save", 0, 1, 0.8]];
for (const [i, [step, input, out, secs]] of steps.entries()) {
  await db.execute(sql`insert into news_run_steps (run_id, step, seq, status, input_count, output_count, detail, started_at, finished_at) values (${runId}, ${step}, ${i + 1}, 'succeeded', ${input}, ${out}, ${JSON.stringify({ seconds: secs })}::jsonb, now() - interval '25 minutes', now() - interval '21 minutes')`);
}
const logs: [string, string, string][] = [
  ["fetch", "info", "fetch: started"],
  ["fetch", "warning", "source HashiCorp blog failed: robots.txt of www.hashicorp.com does not allow fetching /blog/feed.xml."],
  ["fetch", "info", "fetch: succeeded in 6.2s"],
  ["dedupe", "info", "dedupe: succeeded in 0.4s"],
  ["select", "info", "select: succeeded in 0.1s"],
  ["draft", "info", "draft: succeeded in 142.0s"],
  ["quality", "info", "quality gates passed"],
  ["image", "info", "image: succeeded in 3.4s"],
  ["save", "info", "draft ready for review: Kubernetes 1.35 makes in-place pod resize stable"],
];
for (const [step, level, message] of logs) await db.execute(sql`insert into news_run_logs (run_id, step, level, message) values (${runId}, ${step}, ${level}, ${message})`);

const cl = async (title: string, sources: number, topics: string) => rowsOf<{ id: string }>(await db.execute(sql`insert into news_clusters (title, source_count, item_count, burst, topics) values (${title}, ${sources}, ${sources}, 0.42, ${topics}::jsonb) returning id`))[0]!.id;
const c1 = await cl("Demo: Kubernetes 1.35 makes in-place pod resize stable", 3, '[{"slug":"kubernetes","p":0.93}]');
const c2 = await cl("Demo: Helm chart repository index format change", 1, '[{"slug":"kubernetes","p":0.61}]');
const c3 = await cl("Demo: webinar on platform engineering", 1, '[{"slug":"devops-sre","p":0.7}]');
const c4 = await cl("Demo: kubelet patch release", 2, '[{"slug":"kubernetes","p":0.88}]');
const bd = (v: Record<string, number>) => ({ model: "v1-weighted", features: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, { value: x, weight: 0.11, contribution: Math.round(x * 0.11 * 1000) / 1000 }])) });
const cand = async (c: string, score: number, decision: string, reason: string, f: Record<string, number>, rank: number | null) =>
  db.execute(sql`insert into news_candidates (run_id, job_id, cluster_id, features, score, breakdown, model_version, decision, reason, rank) values (${runId}, ${job.id}, ${c}, ${JSON.stringify(f)}::jsonb, ${score}, ${JSON.stringify(bd(f))}::jsonb, 'v1-weighted', ${decision}, ${reason}, ${rank})`);
await cand(c1, 0.71, "selected", "selected: score 0.71, rank 1", { credibility: 0.93, source_count: 0.63, burst: 0.42, recency: 0.95, topic_match: 0.93, audience: 0.48, novelty: 0.88, severity: 0, keyword_overlap: 0.3 }, 1);
await cand(c4, 0.52, "rejected", "per-run cap (2) reached", { credibility: 0.95, source_count: 0.39, burst: 0.2, recency: 0.9, topic_match: 0.88, audience: 0.3, novelty: 0.9, severity: 0, keyword_overlap: 0.1 }, null);
await cand(c2, 0.36, "rejected", "score 0.36 below the job's threshold 0.40", { credibility: 0.8, source_count: 0, burst: 0, recency: 0.7, topic_match: 0.61, audience: 0.3, novelty: 0.95, severity: 0, keyword_overlap: 0.1 }, null);
await cand(c3, 0.44, "rejected", "excluded keyword “webinar”", { credibility: 0.8, source_count: 0, burst: 0, recency: 0.8, topic_match: 0, audience: 0.3, novelty: 1, severity: 0, keyword_overlap: 0 }, null);

const body = `Version 1.35 of Kubernetes is out, and for anyone running stateful or bursty workloads the release brings a welcome change: in-place pod resize is now stable. You can raise or lower the CPU and memory of a running container without recreating its pod. The project counts 42 enhancements in this cycle.

## Why it matters

Until now, giving a busy service more memory meant a restart, which drops connections and empties warm caches. Teams worked around that by over-provisioning, which wastes money on every node. A stable resize path lets you right-size live workloads during an incident or a traffic spike, and it makes vertical autoscaling far less disruptive.

## What to do

Check that your container runtime supports the resize API before you depend on it. Then try a resize on a non-critical deployment in a staging cluster and watch the pod status field, where the kubelet now reports progress. Update your runbooks so on-call engineers know they can resize instead of restarting.`;
const src = [{ title: "Demo source: Kubernetes v1.35 release", publisher: "Kubernetes", url: "https://kubernetes.io/blog/", accessed_at: new Date().toISOString().slice(0, 10) }];
const cover = process.env.NEWS_COVER_B64 ? `data:image/webp;base64,${process.env.NEWS_COVER_B64}` : undefined;
const quality = { passed: true, failed: [], gates: Object.fromEntries(["source_similarity", "grounding", "quotes", "value", "style", "seo", "duplicate"].map((g) => [g, { passed: true, failures: [], warnings: g === "grounding" ? ["Kubernetes is mentioned but not in any source (fine as context; check it is not a claim)"] : [] }])) };
const doc = {
  title: "Kubernetes 1.35 makes in-place pod resize stable",
  slug_suggestion: "demo-kubernetes-1-35-in-place-pod-resize",
  meta_description: "Kubernetes 1.35 makes in-place pod resize stable: what changed, why it matters for platform teams, and what to check before relying on it.",
  outline: ["Why it matters", "What to do"],
  body_mdx: body,
  sources: src.map((s) => ({ url: s.url, title: s.title, used_for: s.publisher })),
  fact_check_flags: [],
  internal_links: [],
  news: { dek: "Operators can now change CPU and memory on running pods without a restart.", categories: ["kubernetes"], tags: ["kubernetes", "autoscaling"], sources: src, quality, job_name: job.name, image: cover ? { provider: "template", aiGenerated: false, alt: "Blue gradient cover with a network of connected circles and the headline about Kubernetes 1.35 pod resize.", src: cover } : null },
};
const [art] = rowsOf<{ id: string }>(await db.execute(sql`insert into news_articles (job_id, job_version, run_id, cluster_id, status, score, generated_doc, sources, fact_sheet, quality, similarity, cost_usd, tokens)
  values (${job.id}, 2, ${runId}, ${c1}, 'drafting', 0.71, ${JSON.stringify(doc)}::jsonb, ${JSON.stringify(src)}::jsonb,
  ${JSON.stringify({ claims: [{ id: "f1", claim: "Kubernetes 1.35 released; in-place pod resize is stable", source_url: src[0]!.url, snippet: "in-place pod resize graduates to stable", kind: "version" }, { id: "f2", claim: "42 enhancements in the release", source_url: src[0]!.url, snippet: "42 enhancements", kind: "number" }] })}::jsonb,
  ${JSON.stringify(quality)}::jsonb, ${JSON.stringify({ passed: true, detail: { top_matches: [{ paragraph: 0, source: src[0]!.url, overlap: 0.04, longest_run: 6, excerpt: "Version 1.35 of Kubernetes is out…" }] } })}::jsonb, 0.2391, 84210) returning id`));
const saved = await newsSaveDraft({ articleId: art!.id, jobId: job.id, jobName: job.name, document: doc, flags: [], categories: ["kubernetes"], tags: ["kubernetes", "autoscaling"], image: null, runId, author: null });
await db.execute(sql`update news_articles set status = 'ready_for_review' where id = ${art!.id}`);
console.log(JSON.stringify({ job: job.id, run: runId, draft: (saved as { draftId?: string }).draftId, errors: (saved as { errors?: string[] }).errors }));
process.exit(0); // PGlite keeps the event loop alive

export {}; // a module, so top-level await type-checks
