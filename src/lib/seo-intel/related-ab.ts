import { getDb } from "@/db";
import { getPublishedContent, relatedArticles, type Article } from "@/lib/content";
import { mlRelated, relatedPlan } from "./ml";

/**
 * Related articles for the public article page, with the v5 A/B experiment (ml.ts relatedPlan). Reads only the
 * precomputed `seo_ml_related_articles` table; nothing is computed per request. Any error → the rule list.
 */
export async function relatedForArticle(article: Article, limit: number): Promise<{ items: Article[]; arm: "model" | "rule" | null; source: string }> {
  const rule = await relatedArticles(article, limit);
  if (!article.id || article.preview) return { items: rule, arm: null, source: "rule" };
  try {
    const db = await getDb();
    const plan = await relatedPlan(db, article.id);
    if (plan.use === "rule") return { items: rule, arm: plan.arm, source: plan.label };
    const ml = await mlRelated(db, article.id, limit * 2);
    if (!ml.length) return { items: rule, arm: plan.arm, source: "rule" };
    const all = (await getPublishedContent()).filter((a) => a.path !== article.path);
    const byId = new Map(all.filter((a) => a.id).map((a) => [a.id!, a]));
    const explicit = article.frontmatter.related.flatMap((ref) => all.filter((a) => `${a.collection}/${a.slug}` === ref));
    const picked = [...explicit];
    for (const r of ml) {
      const a = byId.get(r.id);
      if (a && !picked.includes(a)) picked.push(a);
    }
    for (const a of rule) if (!picked.includes(a)) picked.push(a); // top up if the model knows fewer articles
    return { items: picked.slice(0, limit), arm: plan.arm, source: plan.label };
  } catch {
    return { items: rule, arm: null, source: "rule" };
  }
}
