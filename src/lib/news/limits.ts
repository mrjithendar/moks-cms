/**
 * Caps the news job schema (schema.ts) and the Job editor (components/news/JobEditor.tsx) share, so the editor stops
 * where the save would refuse. Kept apart from schema.ts so the client component does not pull in every schema.
 * The news agent checks the same cap (mrjithendar/newsroom app/news/config.py, JobConfig.default_categories).
 */
export const MAX_DEFAULT_CATEGORIES = 5;
