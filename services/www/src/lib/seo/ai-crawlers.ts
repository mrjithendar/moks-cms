import { siteFile as siteJson } from "@/config/site";

/**
 * AI crawlers, by what an Allow gives them:
 * - `search`: fetch pages to answer a reader's question and cite them (ChatGPT search, Claude, Perplexity). Blocking
 *   these removes the site from AI answers.
 * - `training`: collect pages for model training. Blocking these does not affect search or AI answers.
 *
 * The policy is per site (`aiCrawlers` in the site's site.json, both default "allow") and is written into robots.txt
 * as one explicit group per crawler, so the technical audit can verify it and readers of robots.txt see the intent.
 * Tokens are the robots.txt product tokens each vendor documents (Google-Extended and Applebot-Extended are tokens
 * only: no crawler sends them as a User-Agent).
 */
export type AiCrawlerPurpose = "search" | "training";
export type AiCrawler = { token: string; vendor: string; purpose: AiCrawlerPurpose; /** A User-Agent the crawler sends, for the access check; null for robots-only tokens. */ userAgent: string | null };

export const AI_CRAWLERS: readonly AiCrawler[] = [
  { token: "OAI-SearchBot", vendor: "OpenAI", purpose: "search", userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot" },
  { token: "ChatGPT-User", vendor: "OpenAI", purpose: "search", userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot" },
  { token: "Claude-SearchBot", vendor: "Anthropic", purpose: "search", userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-SearchBot/1.0; +Claude-SearchBot@anthropic.com)" },
  { token: "Claude-User", vendor: "Anthropic", purpose: "search", userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)" },
  { token: "PerplexityBot", vendor: "Perplexity", purpose: "search", userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)" },
  { token: "Perplexity-User", vendor: "Perplexity", purpose: "search", userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)" },
  { token: "GPTBot", vendor: "OpenAI", purpose: "training", userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.1; +https://openai.com/gptbot" },
  { token: "ClaudeBot", vendor: "Anthropic", purpose: "training", userAgent: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)" },
  { token: "Google-Extended", vendor: "Google", purpose: "training", userAgent: null },
  { token: "Applebot-Extended", vendor: "Apple", purpose: "training", userAgent: null },
  { token: "CCBot", vendor: "Common Crawl", purpose: "training", userAgent: "CCBot/2.0 (https://commoncrawl.org/faq/)" },
  { token: "meta-externalagent", vendor: "Meta", purpose: "training", userAgent: "meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)" },
];

export type AiCrawlerPolicy = Record<AiCrawlerPurpose, "allow" | "block">;

export function aiCrawlerPolicy(file: unknown = siteJson): AiCrawlerPolicy {
  const raw = (file as { aiCrawlers?: Partial<Record<string, unknown>> }).aiCrawlers ?? {};
  const pick = (v: unknown) => (v === "block" ? "block" : "allow");
  return { search: pick(raw.search), training: pick(raw.training) };
}

export const aiCrawlerAllowed = (c: AiCrawler, policy: AiCrawlerPolicy) => policy[c.purpose] === "allow";
