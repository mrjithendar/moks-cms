# jithendar.com style guide (generated)

Measured from 39 articles (37 blog, 2 news; 125,728 words of prose) by `scripts/seo-style-guide.ts`. Drafts must read as if the same author wrote them.

## Voice and tone
- Voice: first person singular ("I") where the author reports what they built, checked or decided. Per 1,000 words: "I/my/me" 2.7, "we/our" 0.8, "you/your" 4.2.
- Direct, technical and specific: name the tool, the version and the command; explain why, then how. No hype, no marketing adjectives, no filler intros ("In today's fast-paced world…").
- Claims are checked: the articles cite sources and state what was verified. Never add a claim, number, version or command that is not in the article or a cited source.
- Spelling: mixed; keep each article's existing spelling (counted 29 British vs 26 American forms). Em dashes appear 0.0 times per 1,000 words; the serial (Oxford) comma is common.

Openings, verbatim, for tone:

> You have deployed an application to Kubernetes. The pods run, the Service answers, every check is green.

> [Part 1](/blog/15-essential-kubernetes-tools-devops-engineers-2026-part-1) covered getting software into a cluster and watching it. This part covers keeping it running under load and under attack: **Karpenter and KEDA** for scaling, **Istio, Linkerd and Cilium** for networking, *

> Anyone can send an HTTP request to a form endpoint; a browser is one way, a ten-line script is another. This tutorial shows how jithendar.com protects its email sign-in, sign-up and contact form with Cloudflare Turnstile, using the site's real Next.js code: the widget in React, v

> Until this week, every application on `mk4` (the 8-node Minikube cluster that runs this website, the MOKS SRE portal, Harbor and RoboShop AI) brought its own PostgreSQL: one single-replica pod each, four in total, four sets of credentials, four volumes and no failover. This artic

## Structure
- Headings: 88% sentence case (capitalise only the first word and proper nouns). 465 H2, 559 H3, 0 H4 across all articles; the title is the only H1 (never add an H1 to the body). Do not skip levels.
- 6% of headings are questions; FAQ-style sections use questions as H2/H3 with a short direct answer underneath.
- Paragraphs: median 31 words; sentences: median 15 words. Keep added paragraphs in that range.
- Lists are common (32.7 list items per article) for steps, options and checks; tables (143 in total) for comparisons. Callout directives (`:::note` etc.) appear 53 times.

## Code
- 944 fenced blocks; 100% declare a language. Most used: `python` (265), `bash` (162), `text` (91), `typescript` (89), `yaml` (88), `ts` (74), `hcl` (50), `go` (42), `tsx` (25), `mermaid` (20).
- Code blocks are copy-paste ready and are never edited by an SEO draft unless the change explicitly targets that block and cites a source.
- Inline code for commands, flags, file names, resource kinds and env vars.

## Titles and descriptions
- Article titles: median 77 characters. Search titles (seoTitle) should stay ≤ 60 characters, lead with what the reader searches for, and stay accurate; no clickbait, no year unless the article is about that year.
- Descriptions: median 149 characters; meta descriptions ≤ 155 characters, one or two plain sentences that say what the reader gets.

## Links
- Internal links use natural phrases already in the sentence (2–6 words), never "click here"; at most one link per target per article.
