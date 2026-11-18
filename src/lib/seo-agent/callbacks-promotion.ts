import { z } from "zod";
import { log } from "../log";
import { syncReddit, type RedditSync } from "../seo-intel/promotion/reddit";
import { draftsSchema, ideaSignals, ideasSchema, PromotionError, refreshOpportunities, saveDrafts, saveIdeas } from "../seo-intel/promotion/store";
import { CallbackError } from "./callbacks";

/**
 * Promotion callbacks for the seo-agent's promotion_flow and content_ideas_flow (docs/seo/PROMOTION.md). The agent has
 * no internet egress except the Anthropic API, so the Reddit read happens here; the scoring is this app's deterministic
 * code; the crew only writes text. The two writes store drafts and ideas for a person to review. Nothing here posts
 * to any channel, publishes an article or changes the editorial calendar.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new CallbackError(`Invalid request: ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).slice(0, 5).join("; ")}`, 400, "invalid");
  return r.data;
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PromotionError) throw new CallbackError(e.message, e.status, e.status === 404 ? "not_found" : "invalid");
    throw e;
  }
}

/** A Reddit failure never fails the flow: promotion then works from the article and Search Console data alone. */
async function reddit(): Promise<Pick<RedditSync, "status" | "message" | "stored">> {
  try {
    const r = await syncReddit();
    return { status: r.status, message: r.message, stored: r.stored };
  } catch (e) {
    log.error("reddit sync failed", { err: e, operation: "promotion_reddit_sync" });
    return { status: "error", message: "The Reddit sync failed.", stored: 0 };
  }
}

const collectBody = z.object({ articleId: z.string().regex(UUID).nullish(), limit: z.number().int().min(1).max(10).nullish() }).strict();

/** POST /promotion/collect {articleId?, limit?} — refresh Reddit threads, score channels, return what to draft. */
export async function promoCollect(body: unknown) {
  const b = parse(collectBody, body);
  const r = await reddit();
  const c = await guarded(() => refreshOpportunities({ articleId: b.articleId ?? undefined, limit: b.limit ?? undefined }));
  return { ...c, reddit: r };
}

/** POST /promotion/articles/{id}/drafts {runId?, posts[]} — the crew's drafts, stored for review. */
export async function promoSaveDrafts(articleId: string, body: unknown) {
  if (!UUID.test(articleId)) throw new CallbackError("Invalid article id.", 400, "invalid");
  return guarded(() => saveDrafts(articleId, parse(draftsSchema, body)));
}

/** POST /promotion/ideas/signals — refresh Reddit threads, then the demand signals the strategist may use. */
export async function promoIdeaSignals() {
  const r = await reddit();
  return { ...(await ideaSignals()), redditSync: r };
}

/** POST /promotion/ideas {runId?, ideas[]} — store ideas whose evidence checks out against the site's own data. */
export async function promoSaveIdeas(body: unknown) {
  return guarded(() => saveIdeas(parse(ideasSchema, body)));
}
