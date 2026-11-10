import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { rowsOf } from "@/db/rows";
import { audit } from "../audit";
import type { Actor } from "../posts";

/**
 * Suggested starter sources (docs/news/SOURCES.md). Imported **disabled**: the owner reviews each source's terms and
 * enables it. Verified 2026-11-10 from this repository's development machine: every URL answered HTTP 200 with a feed or
 * JSON content type, and its host's robots.txt allows the path for the news desk's User-Agent (evaluated with the site's
 * own robots parser). Not included, and why:
 * - GitHub `…/releases.atom`: github.com's robots.txt disallows `/*.atom$` for every crawler → the official REST API
 *   (`api.github.com/repos/{owner}/{repo}/releases`, no robots.txt) is used instead, 60 unauthenticated requests/hour,
 *   so these poll every 6 hours.
 * - Azure blog feed: its robots.txt disallows the path for generic crawlers.
 * - NVD CVE API 2.0: needs date-range parameters per request; add it as a json_api source with your own query (SOURCES.md).
 */
type Starter = { name: string; type: "rss" | "atom" | "json_api" | "github_releases"; url: string; credibility: number; interval: number; hints: string[]; terms: string };

const GH = (repo: string, hints: string[]): Starter => ({ name: `${repo} releases (GitHub API)`, type: "github_releases", url: `https://api.github.com/repos/${repo}/releases?per_page=10`, credibility: 0.95, interval: 360, hints, terms: "GitHub REST API terms; release notes are the project's own. Unauthenticated: 60 requests/hour per IP." });

export const STARTER_SOURCES: Starter[] = [
  { name: "Kubernetes blog", type: "rss", url: "https://kubernetes.io/feed.xml", credibility: 0.95, interval: 120, hints: ["kubernetes"], terms: "CC BY 4.0 (kubernetes.io). Summarise and link; do not republish." },
  { name: "AWS What's New", type: "rss", url: "https://aws.amazon.com/about-aws/whats-new/recent/feed/", credibility: 0.9, interval: 60, hints: ["aws-cloud"], terms: "AWS Site Terms. Summaries with attribution and a link only." },
  { name: "AWS News Blog", type: "rss", url: "https://aws.amazon.com/blogs/aws/feed/", credibility: 0.9, interval: 120, hints: ["aws-cloud"], terms: "AWS Site Terms. Summaries with attribution and a link only." },
  { name: "CNCF blog", type: "rss", url: "https://www.cncf.io/feed/", credibility: 0.8, interval: 180, hints: ["kubernetes", "devops-sre"], terms: "CNCF site terms; many posts are guest posts (check the author)." },
  { name: "HashiCorp blog", type: "rss", url: "https://www.hashicorp.com/blog/feed.xml", credibility: 0.85, interval: 180, hints: ["infrastructure-as-code"], terms: "HashiCorp website terms. Summaries with a link only." },
  { name: "Google Cloud blog", type: "rss", url: "https://cloudblog.withgoogle.com/rss/", credibility: 0.85, interval: 180, hints: ["aws-cloud", "ai-engineering"], terms: "Google terms of service. Summaries with a link only." },
  { name: "OpenAI news", type: "rss", url: "https://openai.com/news/rss.xml", credibility: 0.8, interval: 180, hints: ["ai-engineering", "ai-agents"], terms: "OpenAI terms of use. Summaries with a link only." },
  { name: "CISA Known Exploited Vulnerabilities", type: "json_api", url: "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json", credibility: 0.95, interval: 360, hints: ["cybersecurity"], terms: "US government work (public domain in the US); cite CISA." },
  GH("kubernetes/kubernetes", ["kubernetes"]),
  GH("hashicorp/terraform", ["infrastructure-as-code"]),
  GH("argoproj/argo-cd", ["kubernetes", "devops-sre"]),
  GH("istio/istio", ["kubernetes"]),
  GH("Kong/kong", ["kubernetes", "devops-sre"]),
  GH("prometheus/prometheus", ["devops-sre"]),
  GH("grafana/grafana", ["devops-sre"]),
  GH("langchain-ai/langchain", ["ai-agents"]),
  GH("crewAIInc/crewAI", ["ai-agents"]),
  GH("modelcontextprotocol/python-sdk", ["ai-agents"]),
  GH("modelcontextprotocol/typescript-sdk", ["ai-agents"]),
];

/** Insert the starter sources that are not there yet (by URL), all disabled. Returns how many were added. */
export async function importStarterSources(actor: Actor) {
  const db = await getDb();
  let added = 0;
  for (const s of STARTER_SOURCES) {
    const r = rowsOf<{ id: string }>(
      await db.execute(sql`
        insert into news_sources (name, type, url, topic_hints, credibility, fetch_interval_minutes, enabled, terms_note, created_by)
        select ${s.name}, ${s.type}, ${s.url}, ${`{${s.hints.join(",")}}`}::text[], ${s.credibility}, ${s.interval}, false, ${s.terms}, ${actor.label}
        where not exists (select 1 from news_sources where url = ${s.url} and deleted_at is null) returning id`),
    );
    added += r.length;
  }
  await audit(actor, "news.source.import_starters", "news_sources", { added });
  return { added, total: STARTER_SOURCES.length };
}
