import type { TopicsSettings } from "./settings";
import type { SourceDeps } from "./sources";

/**
 * Keyword difficulty for topic discovery (docs/seo/TOPICS.md "Difficulty").
 *
 * Default: a PROXY, 0 (easy) to 100 (hard), from what the site can observe itself. It is not a measurement of the
 * competition on the results page and is labelled "proxy" everywhere it is shown.
 * Optional: DataForSEO Labs "bulk keyword difficulty" (real difficulty for Google), used when it is switched on in
 * the topic settings and DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD are saved (Admin → Advanced settings).
 */
export type ProxyInput = { words: number; position: number | null; fit: number; trendOnly: boolean };

export function proxyDifficulty(f: ProxyInput): { value: number; reasons: string[] } {
  let v = 50;
  const reasons: string[] = [];
  if (f.words >= 4) {
    v -= 15;
    reasons.push("long-tail phrase");
  } else if (f.words <= 2) {
    v += 15;
    reasons.push("short head term");
  }
  if (f.position !== null && f.position <= 30) {
    v -= 12;
    reasons.push(`the site already appears for it (position ${f.position.toFixed(1)})`);
  } else if (f.position !== null && f.position > 50) {
    v += 5;
    reasons.push("the site is far down the results today");
  }
  if (f.fit >= 0.6) {
    v -= 10;
    reasons.push("close to topics the site already covers");
  } else if (f.fit < 0.3) {
    v += 10;
    reasons.push("far from what the site has covered");
  }
  if (f.trendOnly) {
    v += 5;
    reasons.push("no search data yet");
  }
  return { value: Math.max(5, Math.min(95, v)), reasons };
}

export function dataForSeoConfig(s: TopicsSettings, env: Record<string, string | undefined> = process.env): { login: string; password: string } | null {
  const login = env.DATAFORSEO_LOGIN?.trim();
  const password = env.DATAFORSEO_PASSWORD?.trim();
  return s.dataForSeo.enabled && login && password ? { login, password } : null;
}

/**
 * Difficulty per keyword (lower-cased) from DataForSEO, or null when it is off, not configured, or the request fails
 * (the proxy is used then). One request for up to 200 keywords.
 */
export async function dataForSeoDifficulty(keywords: string[], s: TopicsSettings, deps: SourceDeps = {}): Promise<Map<string, number> | null> {
  const cfg = dataForSeoConfig(s, deps.env);
  const list = [...new Set(keywords.map((k) => k.toLowerCase().trim()).filter((k) => k.length >= 2 && k.length <= 80))].slice(0, 200);
  if (!cfg || !list.length) return null;
  try {
    const res = await (deps.fetchImpl ?? fetch)("https://api.dataforseo.com/v3/dataforseo_labs/google/bulk_keyword_difficulty/live", {
      method: "POST",
      headers: { Authorization: `Basic ${Buffer.from(`${cfg.login}:${cfg.password}`).toString("base64")}`, "Content-Type": "application/json" },
      body: JSON.stringify([{ keywords: list, location_code: s.dataForSeo.locationCode, language_code: s.dataForSeo.languageCode }]),
      signal: AbortSignal.timeout(30_000),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { tasks?: { result?: { items?: { keyword?: unknown; keyword_difficulty?: unknown }[] }[] }[] };
    const out = new Map<string, number>();
    for (const item of data.tasks?.[0]?.result?.[0]?.items ?? []) {
      const kd = item.keyword_difficulty;
      if (typeof item.keyword === "string" && typeof kd === "number" && Number.isFinite(kd)) out.set(item.keyword.toLowerCase(), Math.max(0, Math.min(100, kd)));
    }
    return out.size ? out : null;
  } catch {
    return null;
  }
}
