import type { AnalyticsFilter } from "./service";

/**
 * Content analytics filters from the address (AI & SEO → Content analytics). Anything that is not one of the known
 * shapes is ignored, so a link can never put arbitrary text into a query. Pure: the page and the tests import it.
 */
const PERIODS = [7, 30, 90, 365];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,60}$/;

export function filterFrom(sp: Record<string, string | undefined>): AnalyticsFilter {
  const days = Number(sp.days);
  return {
    days: PERIODS.includes(days) ? days : 90,
    jobId: sp.job && UUID.test(sp.job) ? sp.job : null,
    output: sp.output === "news" || sp.output === "article" ? sp.output : null,
    category: sp.category && SLUG.test(sp.category) ? sp.category : null,
    topic: sp.topic && SLUG.test(sp.topic) ? sp.topic : null,
    sourceId: sp.source && UUID.test(sp.source) ? sp.source : null,
  };
}

