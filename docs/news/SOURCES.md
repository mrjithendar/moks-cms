# Sources

AI & SEO → Content sources. A source is a feed or official API content flows read (for news and for other content); nothing is hard-coded.

## Types

| Type | Parsed as | Notes |
|---|---|---|
| `rss`, `atom` | RSS 2.0 / RDF / Atom | preferred |
| `github_releases` | GitHub REST API `GET /repos/{owner}/{repo}/releases` (JSON); Atom also accepted | github.com's robots.txt disallows `/*.atom$`, so use the API URL `https://api.github.com/repos/<owner>/<repo>/releases?per_page=10`. Unauthenticated limit: 60 requests/hour per IP → poll every 6 h |
| `json_api` | JSON Feed 1.1, CISA KEV catalogue, NVD CVE API 2.0 | NVD needs a date range in the URL, e.g. `https://services.nvd.nist.gov/rest/json/cves/2.0?pubStartDate=…&pubEndDate=…`; choose your own query |
| `sitemap` | Google News sitemap (`news:title`) | entries without a title are skipped |
| `html_allowlisted` | one page → one item; its content hash decides if it changed | only for a page without a feed, after checking its terms |

XML with a DOCTYPE or ENTITY declaration is refused before parsing. Each fetch stores up to 50 items (Settings).

## How fetching works

Through the web app's v1 SSRF-safe fetcher (DECISIONS N-05):

1. https only; the URL's host must be the source's own host (feeds) or on the primary-source allowlist (the
   Researcher's `fetch_allowlisted`: source hosts + a default list of vendor/project hosts + Settings → extra hosts + the
   docs allowlist). DNS is resolved inside the socket; private and reserved ranges are refused; redirects are re-checked.
2. robots.txt of the origin is read (cached 6 h) and evaluated for the User-Agent token `jithendarnewsdesk`. 4xx = no
   restrictions; 429, 5xx or unreachable = treated as disallowed for 30 minutes (Google's rules).
3. Paywalled hosts (Settings) are refused, here and when a source is saved.
4. `User-Agent: JithendarNewsDesk/1.0 (+https://jithendar.com; feed reader for the site's news desk)`, `If-None-Match` /
   `If-Modified-Since` from the last fetch; 304 = not modified. 15 s timeout, 3 MB (feeds) / 1.5 MB (pages), 3 redirects.
5. Health after every fetch: last fetch/success, status, HTTP code, error counts, average items, items total.

## Credibility

0–1, used in the score. Start with: official vendor/project release notes and advisories 0.9–0.95; vendor blogs 0.85–0.9;
foundation/community blogs 0.75–0.8; aggregators 0.5. The Sources page suggests changes from your decisions (approval
rate and "inaccurate" rejections, at least 5 decisions); nothing changes until you apply a suggestion.

## Starter sources

"Import starter sources" adds this list, **disabled**. Each URL was checked on 2026-11-10 (HTTP 200 with a feed or JSON
content type, and its robots.txt allows the path for the news desk). Review each source's terms before enabling it.

| Source | URL | Terms note |
|---|---|---|
| Kubernetes blog | https://kubernetes.io/feed.xml | CC BY 4.0 |
| AWS What's New | https://aws.amazon.com/about-aws/whats-new/recent/feed/ | AWS Site Terms |
| AWS News Blog | https://aws.amazon.com/blogs/aws/feed/ | AWS Site Terms |
| CNCF blog | https://www.cncf.io/feed/ | CNCF site terms; many guest posts |
| HashiCorp blog | https://www.hashicorp.com/blog/feed.xml | HashiCorp website terms |
| Google Cloud blog | https://cloudblog.withgoogle.com/rss/ | Google terms |
| OpenAI news | https://openai.com/news/rss.xml | OpenAI terms of use |
| CISA KEV | https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json | US government work |
| GitHub releases (API) | kubernetes/kubernetes, hashicorp/terraform, argoproj/argo-cd, istio/istio, Kong/kong, prometheus/prometheus, grafana/grafana, langchain-ai/langchain, crewAIInc/crewAI, modelcontextprotocol/python-sdk, modelcontextprotocol/typescript-sdk | GitHub API terms |

Not included: the Azure blog feed (its robots.txt disallows the path for generic crawlers), GitHub `.atom` feeds (see
above), NVD (needs your own query). Anthropic's newsroom has no feed that was verified here; add one if it exists.

## Legal and terms (read before enabling a source)

- The desk writes **original summaries and analysis** and links to the source; it never republishes articles. Code
  gates block drafts that are too close to any source (QUALITY_GATES.md). Quotes: ≤ 25 words, one per source, attributed.
- Respect each source's terms: some forbid automated access or commercial reuse. Record what you checked in the source's
  terms note. Never add paywalled content (add the host to Settings → Paywalled hosts to make sure).
- Prefer official feeds and APIs to pages; `html_allowlisted` is a last resort.
- Images from sources are never used: covers are generated (IMAGES.md).
- This is not legal advice; for anything unclear, ask the publisher or a lawyer.
