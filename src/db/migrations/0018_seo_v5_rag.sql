-- SEO v5, RAG quality (docs/seo/RAG.md "Score calibration"). Additive only.
-- Ask the Blog records what retrieval returned for each question, so scripts/rag_calibrate.py can suggest a cosine
-- floor from real traffic: [{"score": cosine, "fused": hybrid score, "url": "/blog/slug#anchor", "graded": bool,
-- "cited": bool}] for the top-k excerpts (no IP, no question text beyond what the row already holds; pruned with it).
ALTER TABLE "seo_ask_log" ADD COLUMN IF NOT EXISTS "retrieval" jsonb;--> statement-breakpoint
ALTER TABLE "seo_ask_log" ADD COLUMN IF NOT EXISTS "prompt_version" text;
