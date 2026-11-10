-- Manual rollback of 0019_seo_v5_ml.sql (never applied automatically; deletes every v5 model, signal, label and proposal).
DROP TABLE IF EXISTS "seo_rag_eval_runs";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_ml_labels";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_ga4_page_pairs";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_ml_related_articles";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_ml_weight_proposals";--> statement-breakpoint
ALTER TABLE "seo_query_intents" DROP COLUMN IF EXISTS "prompt_version";--> statement-breakpoint
ALTER TABLE "seo_query_clusters" DROP COLUMN IF EXISTS "source";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_ml_intent_predictions";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_ml_query_embeddings";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_ml_query_clusters";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_ml_decay_signals";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_ml_overrides";--> statement-breakpoint
DROP TABLE IF EXISTS "seo_ml_models";--> statement-breakpoint
DELETE FROM "schema_migrations" WHERE "name" = '0019_seo_v5_ml.sql';
