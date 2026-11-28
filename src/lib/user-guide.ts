/**
 * The in-app user guide (Admin → User manual): how the CMS works, page by page, plus an FAQ. Plain data so the home
 * page can search and filter it in the browser, and so every entry can be a page of its own (the helpers at the end of
 * this file: contents, reading order, related entries). `adminOnly` entries describe pages that only admins (and
 * read-only demo accounts, which see what an admin sees) can open; authors do not get them.
 *
 * Keep entries short and factual, and update them when a page changes: the page descriptions in each admin route are
 * the source these were written from.
 */

export const GUIDE_SECTIONS = [
  "Getting started",
  "Content",
  "Editorial & AI",
  "SEO agent, AI & ML",
  "Insights",
  "Community",
  "Site settings",
  "Operations",
  "Account",
] as const;
export type GuideSection = (typeof GUIDE_SECTIONS)[number];

export type GuideEntry = {
  id: string;
  kind: "guide" | "faq";
  section: GuideSection;
  title: string;
  /** One line, shown in the list. */
  summary: string;
  /** Paragraphs; a line starting with "- " is a list item. */
  body: string[];
  /** The admin page this is about, when there is one. */
  href?: string;
  /** Extra words people search for (synonyms). */
  keywords?: string[];
  adminOnly?: boolean;
  /** A draw.io diagram (public/guide/<name>.drawio.svg; source in docs/guide/diagrams/<name>.drawio). */
  diagram?: { name: string; alt: string };
};

const guides: GuideEntry[] = [
  // Getting started
  {
    id: "tour",
    kind: "guide",
    section: "Getting started",
    title: "A tour of the admin",
    summary: "How the admin is organised and where to find things.",
    href: "/admin",
    keywords: ["overview", "navigation", "menu", "sidebar", "dashboard", "start", "help", "architecture", "filter", "pin", "favourite", "collapse", "icons"],
    diagram: { name: "cms-architecture", alt: "Readers and staff reach the Moks CMS web app through the edge. The web app stores content in PostgreSQL, sessions in Redis and media in Cloudflare R2, and sends email. The SEO agent syncs Google data, drafts through LiteLLM and writes drafts and metrics to PostgreSQL." },
    body: [
      "Moks CMS runs the whole publication from one admin: writing and publishing, search and audience data, AI drafting, comments and enquiries, site design and operations.",
      "The menu on the left is arranged like WordPress's: Dashboard; then the content menus Posts, Media, Pages and Comments; then AI & SEO, Billing and Practice (like plugin menus); then Appearance, Users, Tools and Settings. A line separates the three parts. Every entry opens a submenu with its pages. On a computer or tablet, point at an entry (or click it) and its pages open in a panel beside the menu. On a phone, an entry opens in place, the one you are working in is open, and the browser remembers which entries you opened. An entry shows the total of its badges (pending reviews, unread messages, comments to moderate), so nothing that needs attention is hidden.",
      "- Posts: All posts, Add new post, Categories and Tags, then under Editorial the Editorial calendar, the Review queue and Promotion.",
      "- Pages: All pages, Add new page and the Hire me page. Comments: All comments, Messages and Bookings.",
      "- AI & SEO, in six parts: Flows & crews (CrewAI console, Flows, Runs, Crews, Skills, Import / export; Schedules is part of Flows), Content (Content sources, Topics, Profiles & playground, Content analytics, Keywords, Recommendations, Content audit, Internal linking), Traffic (Search performance, Visitor analytics, Page insights, Reports), Authority & health (Backlinks, AI visibility, Technical health), Models & data (ML models, Article index). Its settings are in Settings, like every other setting. There is no Newsroom and there are no jobs since November 2026: news is one kind of content a content flow writes.",
      "- Billing: what clients pay you. Appearance: Customise opens the Appearance editor; Menus, Homepage and Typography & colours open it at that section.",
      "- Users: All users, Profile and API keys. Tools: Site health, Cache, Backups (export / import), Data sync, Database and Audit log. Settings: All settings, then one entry per category (General, Users & access, Content & publishing, Email, Media & storage, Payments & bookings, AI & models, SEO agent, Assistants, Search & SEO, Integrations, Practice, System). Every setting is there and nowhere else.",
      "Filter menu, at the top, finds a page by name: type a few letters and press Enter to open the first match.",
      "The star beside a page pins it: pinned pages are listed first, under Pinned. Collapse menu, at the bottom, narrows the menu to icons. Help, above it, opens this manual.",
      "The Dashboard greets you with the number of items that need attention across the publication.",
      "On a phone, the Menu button at the top shows the current page and opens the same list.",
    ],
  },
  {
    id: "roles",
    kind: "guide",
    section: "Getting started",
    title: "Roles: admin, author, reader and demo",
    summary: "What each kind of account can see and do.",
    href: "/admin/users",
    keywords: ["permissions", "access", "role", "rights", "read-only", "demo"],
    diagram: { name: "roles-and-access", alt: "Admins and demo users can open every page. Changes from admins and authors pass the role check; changes from demo users are refused with a read-only notice." },
    body: [
      "- Admin: every page, every setting.",
      "- Author: writes and publishes their own posts, manages their author profile and API keys, and moderates comments.",
      "- Reader: a public account for commenting; no admin access.",
      "- Demo (read-only): sees every admin page an admin sees, with real data, but cannot save, publish, delete, send or run anything, and cannot download backups. A banner at the top of each page says so.",
      "Admins change roles in Admin → Users. A role change or ban signs the person out straight away.",
    ],
  },
  {
    id: "demo-mode",
    kind: "guide",
    section: "Getting started",
    title: "Exploring with a demo account",
    summary: "What you can try while signed in as a read-only demo user.",
    keywords: ["demo", "read-only", "trial", "evaluate", "explore", "presentation"],
    body: [
      "A demo account shows the CMS exactly as the site owner uses it. Open any page, use filters, date ranges and search, open articles in the editor and read reports.",
      "Anything that would change something (Save, Publish, Delete, Send, Sync, Generate, Approve) is refused with a read-only notice and nothing is stored. AI and paid external calls are never made, so exploring costs nothing.",
      "Good places to start: Dashboard, Posts (open one in the editor), Search performance, Content audit, Review queue, Appearance (look at the previews), Settings, System status and this guide's FAQ.",
    ],
  },
  {
    id: "find",
    kind: "guide",
    section: "Getting started",
    title: "Using this manual",
    summary: "Browse the contents, search, read a guide on its own page and print the manual.",
    keywords: ["search", "filter", "manual", "documentation", "docs", "faq", "contents", "print", "pdf", "navigation", "breadcrumbs"],
    body: [
      "The manual's home lists every guide by category, the FAQ and the settings reference. The contents on the left (under Contents on a phone) list every guide and question; each opens on its own page, which has its own address to bookmark or share.",
      "A guide's page shows where you are (User manual, the category, the guide), who the page is for, an On this page list, the text and its diagram, where the page is in the admin, the settings of that page with their defaults, related guides, and links to the previous and next page in reading order.",
      "Print / Save as PDF on a guide prints that guide without the menus. Printable manual on the home opens the whole manual on one page, with a contents list, for printing or saving as a PDF.",
      "Type in the search box to match titles, summaries, text and common synonyms (for example “publish”, “backup” or “password”); a suggestion opens that guide. Choose an area to narrow the list, or switch between Guides, FAQ and Settings.",
      "Settings lists every setting and option of the CMS with what it does and its default value, from Appearance to the SEO agent and MCP scopes, each under the page that holds it.",
      "Each article links to the admin page it describes. The address bar keeps your search and filters, so you can bookmark or share a view of the guide.",
    ],
  },

  // Content
  {
    id: "posts",
    kind: "guide",
    section: "Content",
    title: "Writing and publishing posts",
    summary: "Create, review, schedule and publish articles, news and projects.",
    href: "/admin/posts",
    keywords: ["article", "blog", "write", "draft", "publish", "schedule", "news", "project", "status", "workflow"],
    diagram: { name: "publishing-workflow", alt: "An idea becomes a draft, goes to review and is published by a person. AI drafts wait in the review queue; approving publishes and submits them, rejecting changes nothing." },
    body: [
      "Posts lists every article, news item and project with its status: draft, review, published or archived. Filter and search the list, then open a post in the editor.",
      "A post needs a title, a slug (its address), a description used for listings and search results, a category and a content type. News and curated posts also need at least one source.",
      "Publish or schedule from the editor's own buttons, or schedule an item from the Editorial calendar. A calendar item becomes published when its linked post is published.",
      "Each published post has an Insights view with its search and visitor data.",
    ],
  },
  {
    id: "editor",
    kind: "guide",
    section: "Content",
    title: "The editor",
    summary: "Visual and Markdown editing, blocks, images and keyboard shortcuts.",
    href: "/admin/posts",
    keywords: ["tiptap", "markdown", "blocks", "shortcuts", "keyboard", "format", "image", "embed", "callout", "table"],
    body: [
      "Markdown is the stored format. The visual editor is a view over it, so switching between Visual and Markdown never loses anything. If a document contains something the visual editor cannot show exactly, it opens in Markdown mode and says why.",
      "Insert blocks with + (searchable) or by typing / in an empty paragraph. Callouts, figures, galleries, buttons, embeds (YouTube and Vimeo), video, audio, details and a table of contents are available as blocks.",
      "- Save: Ctrl/⌘ S",
      "- Undo / redo: Ctrl/⌘ Z / Ctrl/⌘ Shift Z",
      "- Move a block: Alt Shift ↑ / ↓",
      "- Duplicate a block: Ctrl/⌘ Shift D",
      "- Delete a block: Alt Shift Backspace",
      "Images come from the media library or are uploaded by choosing, dropping or pasting. Alt text is required. The featured image can be chosen, uploaded or generated, with a focal point.",
    ],
  },
  {
    id: "pages",
    kind: "guide",
    section: "Content",
    title: "Pages",
    summary: "About, contact, policies and other standalone pages.",
    href: "/admin/pages",
    keywords: ["about", "contact", "privacy", "terms", "policy", "static page"],
    body: ["Pages are standalone pages that are not part of a feed: About, Contact, privacy policy, terms and so on. They use the same editor as posts."],
  },
  {
    id: "media",
    kind: "guide",
    section: "Content",
    title: "Media library",
    summary: "Upload images, video, audio and PDFs; see where each file is used.",
    href: "/admin/media",
    keywords: ["images", "upload", "files", "video", "audio", "pdf", "r2", "storage", "generate image", "ai image", "unused", "bulk delete", "select"],
    body: [
      "Media keeps every uploaded file. Images are served in modern formats (AVIF/WebP) at the right size for each screen.",
      "Images up to 10 MB upload through the site; video, audio and PDFs up to 200 MB upload directly to storage.",
      "A file shows where it is used, and cannot be deleted while a post still uses it. Removing an image from a post never deletes the file.",
      "Filter by usage to find Unused files (not named by any post, page or site setting); a notice at the top says how many there are and how much space they take. Press Bulk select, then Select all on page, or Select all matching to take every unused file across pages (up to 200 at a time), and Delete permanently. Files still in use are always kept.",
      "Generate image creates a picture with AI (when it is configured in Integrations); you choose whether to keep it.",
    ],
  },
  {
    id: "taxonomy",
    kind: "guide",
    section: "Content",
    title: "Categories and tags",
    summary: "Organise posts by topic; fix or merge tags in one place.",
    href: "/admin/categories",
    keywords: ["category", "tag", "topic", "merge", "rename", "rss", "feed"],
    body: [
      "Categories are the topics that organise posts. Each has its own page and RSS feed.",
      "Tags are free-form labels. Renaming a tag (Admin → Tags) fixes it on every post; renaming it onto an existing tag merges the two.",
    ],
  },
  {
    id: "practice",
    kind: "guide",
    section: "Content",
    title: "Python practice",
    summary: "Problems, roles, the code runner and the AI tutor for /python-practice.",
    href: "/admin/practice",
    keywords: ["python", "exercises", "problems", "coding", "tutor", "challenge", "executor"],
    body: [
      "Python practice manages the interactive coding exercises on the public site: problems, engineering roles and topics, the daily challenge, the sandboxed code runner, the AI tutor and abuse signals.",
      "Its settings (execution, quotas, the AI tutor, the leaderboard, retention) are in Settings → Practice; the page links there.",
      "A new problem is saved as a draft; quality checks and duplicate detection run on save, and you publish it once it validates. Every save creates a new version, and old submissions keep pointing at the version they were graded against.",
    ],
  },

  // Editorial & AI
  {
    id: "calendar",
    kind: "guide",
    section: "Editorial & AI",
    title: "Editorial calendar",
    summary: "Plan articles, generate and improve their drafts, and schedule them to publish.",
    href: "/admin/calendar",
    adminOnly: true,
    keywords: ["plan", "schedule", "pipeline", "ideas", "workflow", "generate draft", "improve", "unscheduled", "delete", "overdue", "past date", "reschedule"],
    body: [
      "Every item is Unscheduled, Scheduled or Published. The tabs at the top show each with its count; the filters narrow the list by source, draft state, date, category and cluster, search titles, and sort by date, priority, title or newest. The month and week open on today in India Standard Time.",
      "An item whose date has passed while its post is not scheduled says \"date passed\" next to its date, and a note at the top counts them: Show them (the Date filter, Past their date) lists those items, each saying what it needs. Choose a new date with Schedule, finish the draft, or delete the idea. System status counts them under Editorial calendar.",
      "Each item has an arrow before its title: expand it to edit the brief and act on it, collapse it to scan the list.",
      "The draft is checked first: an item linked to a post shows that draft; a post with the same title (a draft you wrote, or an article already published) is linked by itself; a link to a deleted or trashed post is cleared, and the item is planned again (no longer in review). With no draft and nothing published, the item offers Generate draft.",
      "- Generate draft: creates the draft post and, when the SEO agent is set up, writes the article into it (Writing… while it works).",
      "- Improve (once a draft exists): the SEO agent reads the current draft, checks it against fresh research and replaces it with a revised version, unless you edit the post meanwhile. Add instructions if you want something specific.",
      "- Schedule: pick a date and time (India Standard Time; 09:00 when empty). If the draft is written and ready to publish, its post is scheduled and publishes by itself then. Otherwise the date is kept and a note says what is missing (no draft yet, outline only, fact-check errors, fields the post still needs); fix it and press Schedule again. Unschedule returns the post to draft.",
      "- Delete: removes the item from the calendar; its post is kept, and a scheduled post goes back to draft.",
      "Ideas are added automatically every week, each with its source (the Source filter): Search Console (queries with demand and no article), ML query clusters (groups of related searches with at least 100 impressions in 28 days that no article covers), Google Analytics (the next topic for readers of your most engaging articles), AI (questions readers asked Ask the Blog at least twice that no article answered, and the Promotion crew's best ideas) and editorial ideas. At most two per source a week, and none while twelve automatic ideas are still waiting without a draft or a date. Delete an idea you do not want: it is not suggested again.",
      "Add your own ideas with Add an item.",
    ],
  },
  {
    id: "review",
    kind: "guide",
    section: "Editorial & AI",
    title: "Review queue",
    summary: "AI-drafted changes waiting for your approval.",
    href: "/admin/review",
    adminOnly: true,
    keywords: ["approve", "ai", "claude", "draft", "seo", "pending", "queue"],
    body: [
      "The AI (through LiteLLM) drafts improvements and new articles; they wait here for a person. Nothing goes live until you approve an article.",
      "Approving publishes it and submits it to search engines. The sidebar badge shows how many drafts are ready.",
      "Tabs: Articles, News, Not reviewed and Published, each with its count. Filter by search, status (ready, being written, failed, scheduled), kind (optimisation or new article), change type, priority and age, and sort by priority, date or number of changes.",
      "- Not reviewed lists published articles that were never reviewed, or not in the last 90 days, and have no draft in the queue, oldest first, with when they were last reviewed and their open recommendations. Review now (one article) or select up to 25 and press Review selected.",
      "- Rescan for re-review, at the top, sends the next 5, 10 or 25 articles on that list for an AI review: each gets a fresh check of its facts, versions, links, title and meta description. Each one is a model run with a cost, so you confirm first. The drafts appear under Articles as they finish.",
      "- Select drafts to Regenerate them (a fresh review replaces their pending changes) or Reject them together. Approving stays one article at a time, from its review page.",
    ],
  },
  {
    id: "news-desk",
    kind: "guide",
    section: "Editorial & AI",
    title: "Content flows",
    summary: "Flows that find, rank and draft source-grounded content (news or anything else) for review, each on its own schedule.",
    href: "/admin/crewai/flows?kind=content",
    adminOnly: true,
    keywords: ["content flows", "jobs", "crew jobs", "news", "content sources", "sources", "feeds", "topics", "profiles", "playground", "analytics", "budget", "cost"],
    body: [
      "Content flows live under AI & SEO → Flows (there is no separate Newsroom since 2026-11-21; until 2026-11-23 they were called crew jobs and had a Jobs page of their own). A content flow reads content sources, ranks what it finds and drafts content grounded in those sources; news is one kind of content it writes. Nothing publishes without your approval.",
      "- Content flows (Flows → Content flows, New content flow): what each writes (news stories, or evergreen blog articles from the same grounded facts), where it starts from (content sources, ranked and drafted by the News Desk crew, and/or content ideas, which go on the editorial calendar for the Editorial crew), its sources, topics, categories, schedule, models, its own quality gates (empty = the shared ones) and caps, with versions and rollback. Run now, Dry run, Pause and Clone are on its row. The switch at the top (\"Content flows on\") pauses every content flow; sources, flows and profiles stay as they are, and the other flows are not affected. If it says content flows are switched off by the deployment, NEWS_DESK_ENABLED is false there and must be removed before the switch works.",
      "- Runs: a content flow's runs are flow runs, listed under the content flow's name with what each drafted. A run's page adds the timeline, the articles it drafted, every candidate with its score and the reason it was picked or left out, and Retry failed drafts / Rerun flow. Runs of this flow (on a content flow's page) lists only its runs.",
      "- Content sources: the feeds and official APIs content flows read (robots.txt honoured, paywalled sites refused), and how they are fetched.",
      "- Topics: content topics mapped to the site's categories; your corrections train the classifier weekly.",
      "- Content profiles & playground: versioned writing and image styles any content flow writes with, and a playground to try them; proposed versions need your approval.",
      "- Content analytics: what content flows drafted and how it performs once published.",
      "- Shared settings moved to where they belong: content flow limits under Settings → Agent limits, models and quality gates under Settings → AI & drafts, topic classification and ranking under Settings → ML & retrieval, log retention under Settings → Run history. LLM spend counts in LiteLLM's budgets (Settings → AI & models → LiteLLM).",
    ],
  },
  {
    id: "promotion",
    kind: "guide",
    section: "Editorial & AI",
    title: "Promotion",
    summary: "Where each article is worth sharing, with drafted posts.",
    href: "/admin/promotion",
    adminOnly: true,
    keywords: ["social", "share", "linkedin", "marketing", "distribution", "strategy", "reshare", "evergreen", "syndicate", "newsletter", "digest", "reddit"],
    body: [
      "Promotion suggests where each published article is worth sharing, drafts posts for you to edit and post yourself, and suggests new article ideas that already have an audience. Nothing is posted automatically.",
      "Strategies, the first tab, shows seven ways to promote and the articles each applies to right now:",
      "- Launch new articles: posts for each channel in an article's first two weeks (Draft posts).",
      "- Reshare evergreen articles: older articles still earning search clicks and not shared for 90 days. Reshare reopens their channels (the last post is kept as a record) and drafts fresh posts with a new angle. Channels you dismissed stay dismissed.",
      "- Refresh, then reshare: articles whose search clicks fell by 30% or more. Refresh first sends the article for an AI review in the review queue; publish the refreshed version, then reshare it.",
      "- Syndicate to dev.to and Hashnode: post the full article there with the canonical URL pointing to your site, so search engines credit the original.",
      "- Answer questions in communities: Reddit threads that ask what an article answers. Answer in the thread; link only where it helps.",
      "- Link new articles from your own site: suggested internal links to recent articles, accepted in Internal linking.",
      "- Newsletter digest: a ready issue with this week's articles and one evergreen pick, links tagged utm_source=newsletter. Copy it into your newsletter tool.",
    ],
  },

  // Insights
  {
    id: "search-performance",
    kind: "guide",
    section: "Insights",
    title: "Search performance",
    summary: "Google Search Console clicks, impressions, CTR and position.",
    href: "/admin/search",
    adminOnly: true,
    keywords: ["google", "search console", "gsc", "seo", "clicks", "impressions", "ctr", "position", "queries"],
    body: [
      "Search performance shows Google Search Console data for a period, compared with the previous one. Change the date range and search type to explore.",
      "Data arrives through Data sync; if numbers look stale, check the latest run there.",
    ],
  },
  {
    id: "analytics",
    kind: "guide",
    section: "Insights",
    title: "Visitor analytics and page insights",
    summary: "Google Analytics 4 traffic, and every page joined with its search data.",
    href: "/admin/analytics",
    adminOnly: true,
    keywords: ["ga4", "google analytics", "traffic", "visitors", "sessions", "landing pages", "audience"],
    body: [
      "Visitor analytics shows Google Analytics 4 data for the chosen period.",
      "Page insights lists every page with Search Console data, joined with its GA4 landing-page sessions and the CMS article, so you can see which articles bring search visitors.",
    ],
  },
  {
    id: "keywords",
    kind: "guide",
    section: "Insights",
    title: "Keywords and recommendations",
    summary: "Keyword opportunities and evidence-backed suggestions.",
    href: "/admin/keywords",
    adminOnly: true,
    keywords: ["keyword", "difficulty", "volume", "dataforseo", "opportunities", "tracked", "suggestions", "recommendations"],
    body: [
      "Keyword opportunities come from your Search Console data (anonymised queries are not included, so totals are partial). Search volume and keyword difficulty come from DataForSEO when it is configured. Track the keywords you care about.",
      "Recommendations are rule-based, evidence-backed suggestions. Scores are priorities, not forecasts. Approving records your decision; nothing is changed on the site. AI explanations are labelled and should be verified.",
    ],
  },
  {
    id: "content-audit",
    kind: "guide",
    section: "Insights",
    title: "Content audit and technical health",
    summary: "Article quality scores and a weekly crawl of the public site.",
    href: "/admin/content-audit",
    adminOnly: true,
    keywords: ["audit", "quality", "score", "crawl", "broken links", "canonical", "sitemap", "robots", "meta", "technical seo"],
    body: [
      "Content audit lists every published article, weakest first. Hover, tap or focus a number to see the issues behind it.",
      "Technical health is a weekly polite crawl of the public site: robots.txt, sitemaps, status codes, redirects, canonicals, titles, meta descriptions, headings, alt text, structured data, broken links, orphan pages and more.",
    ],
  },
  {
    id: "links",
    kind: "guide",
    section: "Insights",
    title: "Internal linking and backlinks",
    summary: "Links between your articles, and other sites linking to you.",
    href: "/admin/links",
    adminOnly: true,
    keywords: ["links", "internal links", "backlinks", "referring domains", "dataforseo"],
    body: [
      "Internal linking shows how articles link to each other. A weekly job can add links on its own within strict limits; other link changes are reviewed as drafts.",
      "Backlinks lists sites linking to this one, from DataForSEO's weekly snapshot. It is DataForSEO's crawl, not Google's, so counts differ from Search Console.",
    ],
  },
  {
    id: "ai-visibility",
    kind: "guide",
    section: "Insights",
    title: "AI visibility",
    summary: "Whether AI assistants cite or mention the site, week by week.",
    href: "/admin/ai-visibility",
    adminOnly: true,
    keywords: ["chatgpt", "claude", "perplexity", "gemini", "ai overviews", "citations", "llm", "geo"],
    body: [
      "Each week a set of prompts is asked to the enabled AI assistants with web search on. A prompt counts as cited when an answer links to the site, and mentioned when it names it.",
      "These are API answers; the consumer apps can differ, so read them as a trend. Open a prompt to see the stored answers.",
    ],
  },
  {
    id: "reports",
    kind: "guide",
    section: "Insights",
    title: "SEO-AI reports: briefings and report email",
    summary: "Every report of the site in one list, emailed to the people you choose, with the history of each email.",
    href: "/admin/reports",
    adminOnly: true,
    keywords: ["report", "reports", "weekly", "monthly", "csv", "pdf", "export", "print", "email", "send", "recipients", "attachment", "delivery", "history"],
    body: [
      "SEO-AI reports lists the weekly (last full Monday–Sunday) and monthly SEO briefings and every report made in the CrewAI console, newest first. A briefing compares with the previous period and can be opened, printed, exported as CSV or downloaded as a PDF once the Report crew has made one. Weekly briefing and Monthly briefing make one now.",
      "- Generate and email opens the report form with Email ticked: choose the dates and what to cover, the recipients and whether to attach the PDF. The emails go out when the report is ready.",
      "- Email… on a finished report: tick the configured recipients and add others, choose Attach the PDF when it fits, and open Preview to see the email exactly as it will be sent (title, period, executive summary, key findings, critical recommendations and the download link). Send queues one email per recipient.",
      "- A PDF that is too large for the email provider (Settings → Reports: largest PDF, 0 = the provider's own limit) is never attached: the email carries a signed download link instead, valid for the hours set in Settings → Reports (0 = 7 days, the most Cloudflare R2 allows). Every email also links to the report in the admin, which needs an admin sign-in.",
      "- Email history shows every email: queued, sent (attachment or link), retried after a provider error (tried again with a pause, three times in all) or failed with the reason. Nothing is sent until email is set up under Settings → Email.",
      "- The subject (with {title}, {period} and {site}), an introduction paragraph, attachments, link lifetime and how long console reports are kept are under Settings → Search & SEO → Reports.",
    ],
  },
  {
    id: "crewai-reports",
    kind: "guide",
    section: "SEO agent, AI & ML",
    title: "CrewAI reports: generate, read, download and email",
    summary: "Reports on any dates for any part of the site, analysed by the Report crew, stored in R2 as PDF, HTML, JSON and CSV.",
    href: "/admin/crewai/reports",
    adminOnly: true,
    keywords: ["report", "reports", "site-wide", "analytics", "cost", "llm cost", "budget", "root cause", "recommendations", "action plan", "pdf", "html", "json", "csv", "download", "r2", "email", "date range", "categories"],
    body: [
      "CrewAI console → Reports lists every report of the site with its status, dates, who made it, how long it took, its LLM cost and its files. Search by title and filter by category, status, type (the date preset, or the weekly and monthly briefings) and the dates it was made. New report opens the form.",
      "- Dates: Today, Yesterday, Last 7, 30 or 90 days, This month, Previous month or a custom range, in India Standard Time (at most two years, never in the future). Every figure is compared with the same number of days just before.",
      "- Categories: one, several, or Site-wide (all): CrewAI execution and performance; SEO performance; website traffic; Search Console and keywords; content generation and publishing; the editorial calendar; content quality; AI and LLM usage; LLM cost and budget; workflow reliability and failures; agents and crews; RAG, embeddings and knowledge; technical SEO and site health; infrastructure and operations; business and growth.",
      "- Crews and flows narrow the CrewAI, LLM, reliability and agent categories (crews become the flows that run them). Data sources lists what this site has now, each available, with no data yet (and what to set up), or not available. A source that is not available is reported in the report with the reason: it is never left out silently or filled in.",
      "- The report runs in the background (you can leave the page; its page follows the progress and says when it is ready): the web worker reads the data and stores the HTML, JSON and CSV, then the SEO agent's Report crew writes the analysis and the PDF. Asking for the same report while it is still running opens that one.",
      "- What is in it: an executive summary; what is going wrong (problems found in the data by code, each with its evidence and impact); root causes, each marked Confirmed (the evidence shows it directly, such as a recorded error), Probable or Needs investigation (with the check that would settle it); what can be fixed (severity, impact, steps, expected outcome, estimated effort); AI recommendations; a prioritised action plan (critical, high, medium, low, with an owner when the evidence names one); every category's figures, charts and tables; costs by provider, model, crew, flow, agent and category, cost per run and per AI draft, the cost of failed runs, daily and monthly trends and the LLM budget; and the data sources.",
      "- What the AI may say is checked in code before it is kept: every number must be one of the report's own figures, every item must cite evidence from the report, and a cause called confirmed without direct evidence is shown as probable. Anything that fails is left out and listed at the end. Error messages and log lines are shown to the crew as data, never as instructions. Without the SEO agent, or when the LLM budget refuses, the report is still made with every figure and finding, without the AI part and the PDF, and says why.",
      "- Files: PDF, HTML, JSON and CSV in Cloudflare R2 under reports/<tenant>/<site>/<year>/<month>/<report id>/, private. Download buttons open a link that works for five minutes. Retry starts a failed or cancelled report again; Generate again makes a new one from the same choices (Edit and generate lets you change them first); Cancel stops one that is running; Delete removes it and its files after you confirm. Console reports are kept until deleted, or for the days set in Settings → Search & SEO → Reports.",
      "- Email… sends a finished report (see SEO-AI reports for how the email works); the report's Email history lists each one.",
    ],
  },

  // Community
  {
    id: "comments",
    kind: "guide",
    section: "Community",
    title: "Moderating comments",
    summary: "Review new and reported comments; open, lock or close discussions.",
    href: "/admin/comments",
    keywords: ["comments", "moderation", "spam", "report", "discussion", "approve", "lock"],
    body: [
      "Comments shows new and reported comments for review, and lets you open, lock or close the discussion on each post. The sidebar badge counts what is waiting.",
      "Every decision is recorded in the audit log. Comment text is shown as plain text, so nothing in a comment runs in the admin.",
    ],
  },
  {
    id: "messages",
    kind: "guide",
    section: "Community",
    title: "Messages, bookings and payments",
    summary: "Contact-form messages, booked calls and paid sessions.",
    href: "/admin/messages",
    adminOnly: true,
    keywords: ["contact", "enquiry", "hire me", "cal.com", "booking", "meeting", "razorpay", "payment", "refund"],
    body: [
      "- Messages: contact-form messages and Hire me enquiries. The badge counts unread ones.",
      "- Bookings: meetings booked through Cal.com from the Hire me page. Reschedule or cancel them in Cal.com. The Cal.com webhook secret is set at the end of the Bookings page.",
      "- Payments: paid calls from the Hire me page (Razorpay). Refunds and settlements are handled in the Razorpay dashboard. The Razorpay keys and webhook secret (also used by invoices) are set at the end of the Payments page.",
      "The Hire me page itself is configured under Appearance → Hire me; the Razorpay keys and the Cal.com webhook are in Settings → Payments & bookings. Bills you send to clients are under Invoices.",
    ],
  },
  {
    id: "invoices",
    kind: "guide",
    section: "Community",
    title: "Invoices",
    summary: "Bill a client, take payment through a Razorpay link, and keep every invoice as a PDF.",
    href: "/admin/invoices",
    adminOnly: true,
    keywords: ["invoice", "bill", "billing", "client", "razorpay", "payment link", "pay", "pdf", "download", "receipt", "gst", "vat", "tax", "overdue", "void", "bank transfer", "r2"],
    body: [
      "Invoices is where you bill a client. Every invoice goes the same way: draft, sent, then paid (or void, if you cancel it).",
      "Before the first invoice, press Settings on the Invoices page: your business name and address, your tax ID if you have one, the default currency, tax and payment terms, and the payment details printed at the end of every invoice. File storage must be connected (Settings → Storage), because every invoice is stored there as a PDF.",
      "- New invoice: enter the client, the lines (description, quantity, unit price) and, if you charge it, a tax label and rate. The totals update as you type. Save draft sends nothing.",
      "- Send invoice: the invoice gets the next number (for example INV-2026-0007), its PDF is stored, a Razorpay payment link is made for exactly the total, and the client is emailed a private link where they can view, pay and download it. After that the invoice cannot be edited.",
      "- Paid: when the client pays through the link the invoice is marked paid on its own, the client is thanked by email and you are told. For a bank transfer, press Mark as paid and note the reference; the payment link is cancelled first, so nobody can pay twice.",
      "- Void: cancels a sent invoice and its payment link. The number stays used and the client's link shows the invoice as cancelled. To correct a sent invoice, void it and send a new one (Copy to a new draft saves the typing).",
      "- Download PDF: every sent, paid or void invoice can be downloaded, by you on its page and by the client from their link. The PDF is made again when the invoice is paid or voided, so it always shows where the invoice stands.",
      "Amounts are written with the currency code (USD 1,500.00) on the page, in the email and in the PDF. Numbers run in order within a year and are never skipped or reused. Invoices are not shown to demo accounts.",
    ],
  },

  // Site settings
  {
    id: "appearance",
    kind: "guide",
    section: "Site settings",
    title: "Appearance",
    summary: "Customise the public site with drafts, previews, history and rollback.",
    href: "/admin/appearance",
    adminOnly: true,
    keywords: ["theme", "design", "colours", "colors", "fonts", "logo", "header", "footer", "menu", "navigation", "homepage", "maintenance", "branding"],
    body: [
      "Change the public site without code: general details, branding (logos, favicon, share image), header, navigation menus, footer, typography and colours (with live contrast ratios), the homepage sections, blog listings and the Hire me page.",
      "Changes go into a private draft that you preview on the real pages, then publish explicitly. History lets you roll back, and settings can be exported and imported.",
      "General also holds the site's identity and turns comments, reader sign-up, the contact form, the public user guide and maintenance mode on or off. Settings → General shows these as readers see them now and links here to change them.",
    ],
  },
  {
    id: "settings",
    kind: "guide",
    section: "Site settings",
    title: "Settings",
    summary: "Every setting of the site in one place, by category, with a search.",
    href: "/admin/settings",
    adminOnly: true,
    keywords: ["settings", "configuration", "preferences", "options", "categories", "search settings", "where is", "integrations", "storage", "email", "payments", "practice settings", "backup settings", "cloudflare"],
    body: [
      "Settings (the last menu entry) holds every setting of the site and nothing else holds one: a page that shows records or runs tools (Users, Payments, Bookings, Cache, Backups, Practice, Promotion, Content sources, Configuration) links to its settings instead. All settings lists the categories with their sections and has a search that finds a section by its name or by the name of a field in it (AdSense, SMTP, budget, Turnstile).",
      "- General settings: the site's identity, dates, contact details, features and maintenance mode as readers see them now, and the parts of Appearance. They are part of the site's design, so they are changed in Appearance and go live when it is published.",
      "- Users & access: social sign-in, human verification (Turnstile), members-only articles and profile pictures. Content & publishing: Promotion and IndexNow. Email: the provider and a test message. Media & storage: media storage, video destinations and moving media to R2.",
      "- Payments & bookings: Razorpay (with the webhook URL and its events for paid calls and invoices), Invoices (your business details and a new invoice's defaults) and Cal.com bookings (with the subscriber URL).",
      "- AI & models: LiteLLM, AI & drafts, ML & retrieval, Image generation, Image limits and Video generation. SEO agent: Connection (where the agent is, and the connections), Agent limits, Run history, Content fetching and the Configuration repository. Assistants: Ask the Blog and MCP. Search & SEO: search engine verification, Search Console & GA4, then the SEO areas. The SEO agent's own sections are listed once it is set up (SEO agent → Connection is where it is set up).",
      "- Integrations: Analytics & ads and Hybrid RAG. Practice settings: Python practice (execution, quotas, the AI tutor, the leaderboard, retention). System: Backups (schedule, encryption, bucket) and Cloudflare cache (zone, token, purge on publish).",
      "On a computer the categories are listed on the left and the open one shows its sections; on a tablet or phone a Category list and the section buttons are above the form. Each section saves on its own and returns to itself with a message; leaving a section with unsaved changes asks first. Old addresses (Integrations, Storage, Email, AI & SEO settings, Invoice settings) open the section that has their settings now.",
    ],
  },
  {
    id: "integrations",
    kind: "guide",
    section: "Site settings",
    title: "Connected services",
    summary: "Social sign-in, Turnstile, IndexNow, search-engine verification, analytics and ads, AI image and video generation, and the Hybrid RAG sync (Settings).",
    href: "/admin/settings/integrations",
    adminOnly: true,
    keywords: ["google sign-in", "github", "oauth", "social login", "turnstile", "captcha", "indexnow", "bing", "verification", "search console", "ga4", "analytics", "adsense", "ads.txt", "consent", "reader revenue manager", "publisher center", "rewarded ads", "gemini", "image generation", "veo", "video generation", "client id", "secret", "rag", "moks-rag", "qdrant", "semantic search", "reindex"],
    body: [
      "These sections connect the site to outside services; until November 2026 they were one page, Settings → Integrations, and its old address opens the right section. Secrets are encrypted at rest and never shown again; leave a secret field empty to keep the stored value.",
      "- Social sign-in (Google, GitHub), in Settings → Users & access: register the callback URL shown on the page exactly as given with the provider, then paste the client ID and client secret. Each provider can be switched on or off.",
      "- IndexNow, in Settings → Content & publishing: tells Bing and other IndexNow search engines about new and changed pages straight away. The key file is served by the site so search engines can confirm it belongs to you.",
      "- Human verification (Cloudflare Turnstile), in Settings → Users & access: the site key and secret that protect sign-in, sign-up, comments and the contact form. Wrong keys block sign-in, so test in a private window after saving.",
      "- Search engine verification, in Settings → Search & SEO: the Google Search Console and Bing Webmaster tokens, rendered as meta tags.",
      "- Analytics, ads and consent, in Settings → Integrations: the GA4 measurement ID, the AdSense publisher ID and ad slots, test ads, the consent default, the ads.txt lines and the Reader Revenue Manager product ID (Google Publisher Center).",
      "- Image generation (Google Gemini), in Settings → AI & models: the API key, the Fast image model used by default in the editor, an optional Pro model (better, slower, dearer), the default image size and the largest size authors may pick (caps cost). Image generation limits caps images per author per hour and per day for the whole site.",
      "- Video generation: the Veo model (empty turns it off), resolution, clip length and the hourly and daily caps. It uses the Gemini key; where a clip can go is under Settings → Media & storage → Video destinations.",
      "- Hybrid RAG (moks-rag), in Settings → Integrations: keeps published posts in the shared RAG service so they can be searched by meaning. Publishing or updating a post sends it; unpublishing, trashing, deleting or marking it noindex removes it. Members-only posts send only their free preview. This runs in the background with retries, so saving never waits for it, and the page shows how many syncs went through or failed. It is off until a bearer token is saved (or set in the deployment). Reindex all posts sends every post again (the backfill, also after an import): with the SEO agent it runs as the Hybrid RAG reindex flow, whose run page (AI & SEO → Runs) shows what happened to each post; Test search tries a search over published posts.",
      "A value saved in these sections overrides the deployment's environment variable of the same name; an empty field uses the deployment's value. Search Console, GA4 and DataForSEO data connections are under Settings → Search & SEO → Data sources.",
    ],
  },
  {
    id: "automation",
    kind: "guide",
    section: "SEO agent, AI & ML",
    title: "The SEO agent's settings",
    summary: "In Settings, under four categories: AI & models (LiteLLM), SEO agent, Assistants (Ask the Blog, MCP) and Search & SEO.",
    href: "/admin/settings/ai?section=llm",
    adminOnly: true,
    keywords: ["automation", "seo settings", "schedules", "cron", "scoring", "weights", "thresholds", "budget", "litellm", "llm", "models", "aliases", "drafts", "crawler", "reports", "dataforseo", "ai visibility", "agent limits", "timeout", "turns", "restart pending", "mcp"],
    body: [
      "The SEO agent's settings are sections of Settings (they were AI & SEO → Settings, called Automation & AI before that, until November 2026; old links still open the right section). They are listed once the SEO agent is set up. Each section saves on its own, so a change in one never overwrites another, and every saved change is audit-logged. If you leave a section with unsaved changes, you are asked first.",
      "Settings → SEO agent:",
      "- Connection: the SEO agent (on or off, and its endpoint) and the search and analytics connections. It was drawn twice before (Integrations and AI & SEO → Settings → Overview).",
      "- Agent limits: how many turns, requests, tokens and seconds a crew or a flow may use, and which documentation sites agents may read. These belong to the SEO agent: it checks and stores them. A value you save wins over the deployment's; empty a field to go back to the deployment's value or the default. Each field says whether it applies now or after the agent restarts, and a banner shows while a restart is pending. The limits every crew job shares are below them.",
      "- Run history: what the CrewAI console keeps of each run (model-call transcripts on or off) and how long log lines, transcripts and content flow run logs are kept.",
      "- Content fetching: how content flows fetch their sources (it was on Content sources). Configuration repository: the GitHub repository and token of the CrewAI configuration (it was a tab of Configuration).",
      "Settings → AI & models:",
      "- LiteLLM (it was LLM providers & budget until D-110, 2026-11-28). Every model call of the site goes through LiteLLM, which holds the providers, models, provider keys and budgets; this page only shows them. For the web app and for the SEO agent: whether each reaches LiteLLM, the endpoint, the aliases they ask for and the last health check; then the team's and each key's spend, budget and reset, and the aliases the keys may use with what each points at. Change any of it in LiteLLM (Open LiteLLM). No key is shown here.",
      "- AI & drafts: AI drafting (always stops at human review), the optional explanation model and AI visibility (each assistant through its own LiteLLM alias), then the aliases and quality gates every content flow starts from. Their spend counts in LiteLLM's budgets.",
      "- ML & retrieval: the SEO models and the retrieval check, the SEO agent's Retrieval settings (passages per answer, lowest similarity, how long questions are kept) and Embeddings settings (the backend's address, key and time limit; the embeddings provider and model stay in the deployment, because changing them needs every article embedded again), then how content flows classify topics and train their ranker.",
      "Settings → Assistants:",
      "- Ask the Blog: the reader assistant's switch, who may use it, its limits and wording.",
      "- MCP (one section since November 2026; it was MCP and MCP access): what a connected assistant can and cannot do, the two servers and whether each is on, how to connect Claude, the connected clients with Revoke, then the servers' settings: their switches (they apply at once: a server that is off answers 503), rate limits and the host names they answer to (these apply when the SEO agent restarts). No setting can add a tool or let a client approve, publish or submit content.",
      "Settings → Search & SEO:",
      "- Data sources: which Google properties are read, how far back and how long data is kept; DataForSEO for search volume, difficulty, live rankings and backlinks.",
      "- Schedules: when the web worker runs each job (UTC; weekday 0 = Sunday). While the SEO agent is on, the jobs its flows own run as flows on their own schedules instead (AI & SEO → Flows → Schedules).",
      "- Scoring & rules: the weights and thresholds that find and rank recommendations.",
      "- Content & links: keyword opportunities, internal-linking limits and search-engine submission.",
      "- Crawler: limits for the technical crawl of your own site. Reports: weekly and monthly report email.",
      "Every field is listed with its default under Settings in this guide.",
    ],
  },
  {
    id: "seo-agent",
    kind: "guide",
    section: "SEO agent, AI & ML",
    title: "How the SEO agent works",
    summary: "Flows that sync data, score pages, draft fixes and wait for your approval.",
    href: "/admin/review",
    adminOnly: true,
    keywords: ["seo agent", "crewai", "flows", "crews", "optimize", "new article", "publish flow", "agent", "automation", "kill switch"],
    diagram: { name: "seo-agent-flows", alt: "Schedules start sync flows that fill the SEO data. Rules and ML models score it into recommendations and pick articles worth fixing; drafting flows write drafts within budgets. A person approves on the site, and only then does publish_flow publish and submit." },
    body: [
      "The SEO agent is a separate service that runs CrewAI flows. Sync flows read Google Search Console, GA4 and (optionally) DataForSEO into the database on a schedule.",
      "Rules and ML models turn that data into recommendations, reports and alerts, and pick articles worth improving. Drafting flows (optimize_article_flow, new_article_flow) ask the crews for a draft (through LiteLLM, within its budgets) and keep to the rewrite limit.",
      "Drafts stop at “ready for review”. Only a person approving on the site starts publish_flow, which publishes and submits to search engines. Nothing in the agent, the schedules or MCP can approve.",
      "Start a flow by hand with Run now on the relevant page; queued runs start within about 30 seconds and appear in Data sync.",
    ],
  },
  {
    id: "seo-agent-service",
    kind: "guide",
    section: "SEO agent, AI & ML",
    title: "The seo-agent service, in simple words",
    summary: "A helper program that runs next to the website and does the SEO work in the background.",
    href: "/admin/sync",
    adminOnly: true,
    keywords: ["seo-agent", "service", "python", "background", "jobs", "cronjob", "api", "worker", "how it works"],
    diagram: { name: "cms-architecture", alt: "The SEO agent sits next to the web app: it reads Google data, drafts through LiteLLM and saves drafts and numbers in the shared database." },
    body: [
      "The website and the seo-agent are two separate programs. The website shows pages and the admin. The seo-agent is a Python program that does the slow, background work, so the website stays fast.",
      "- It wakes up on a timetable (for example every morning at 06:10 UTC to fetch Search Console data). Pressing Run now in the admin, or asking through MCP, starts the same job straight away.",
      "- It fetches data from Google and DataForSEO and saves it in the same database the website uses.",
      "- It looks at the numbers, finds pages that can do better and asks the AI (through LiteLLM) to write a suggested fix.",
      "- It saves every suggestion as a draft. It never publishes on its own.",
      "- It also trains the ML models each week, builds reports and keeps the Ask the Blog search index up to date.",
      "Every run is listed in Data sync with its status, what it did and any errors. If the seo-agent is down, the website keeps working; only the background jobs wait.",
    ],
  },
  {
    id: "crewai",
    kind: "guide",
    section: "SEO agent, AI & ML",
    title: "How CrewAI works here, in simple words",
    summary: "Flows are step-by-step recipes; crews are small teams of AI helpers, each with one job.",
    href: "/admin/review",
    adminOnly: true,
    keywords: ["crewai", "crew", "agents", "flow", "ai agents", "multi-agent", "writer", "reviewer", "researcher", "how ai works"],
    diagram: { name: "crewai-how", alt: "A flow runs plain steps, then hands the job to a crew. In the crew an analyst or researcher, a writer or editor and a reviewer work one after another with read-only tools. The flow checks the result and saves a draft for a person to approve." },
    body: [
      "CrewAI is the open-source library the seo-agent uses to organise its AI work. Two ideas matter:",
      "- A flow is a recipe: a fixed list of steps, such as “fetch the article → study the numbers → write a fix → check the fix → save the draft”. Most steps are ordinary code, not AI.",
      "- A crew is a small team of AI helpers (agents). Each agent has one job, a short description of who it is, and a few tools. They work one after another, like an assembly line, and each passes its work to the next.",
      "The crews on this site:",
      "- Optimization crew (improving an existing article): an SEO analyst explains what is wrong from the search data, an editor writes the smallest useful change, and a technical reviewer checks every command and fact against official documentation.",
      "- Editorial crew (a new article): a researcher collects sources, a technical writer writes the draft, a technical reviewer checks it, and an SEO editor suggests the title, description and headings.",
      "- Report crew: one writer turns already-calculated numbers into a short summary. Every number it writes is checked against the real figures; one wrong number and the summary is thrown away.",
      "- Promotion crew: a copywriter drafts social posts for an article, and a content strategist suggests new article ideas with evidence.",
      "Safety rails: agents can only read (no publishing, no deleting, no code running), each has a limit on steps, time and tokens, every call counts against the monthly budget, and article text is treated as data, never as instructions. When a crew finishes, the flow checks its output and saves a draft. Only a person approving in the Review queue can publish it.",
    ],
  },
  {
    id: "ml-how",
    kind: "guide",
    section: "SEO agent, AI & ML",
    title: "How the ML is built, in simple words",
    summary: "Five small models, trained every Sunday, used only when they prove better than the simple rule.",
    href: "/admin/models",
    adminOnly: true,
    keywords: ["machine learning", "ml", "training", "how ml works", "decay", "clusters", "intent", "priority", "related", "lightgbm", "hdbscan", "logistic regression", "embeddings"],
    body: [
      "Every Sunday the seo-agent runs the ML job. For each model it does the same four things: learn from your past data, test itself on data it has not seen, compare its score with the simple rule the site used before, and save the result. The website only reads the saved results; no ML runs while someone loads a page.",
      "- Falling pages (content decay): looks at each page's daily clicks, removes the normal weekly ups and downs (and yearly seasons when there is enough history), and flags a page only when its trend has fallen steadily for three weeks and clearly more than usual. In tests it raised far fewer false alarms than the old 28-day rule.",
      "- Topic groups (query clusters): turns each search query into numbers that capture its meaning (embeddings) and groups queries that mean the same thing. You check a sample of groupings on the Labelling page; the model is used only when it matches your answers better than simple word matching.",
      "- Search intent: learns from intent labels the fast model gave earlier (and your corrections) to tell “how to”, “what is”, comparison and other searches apart by itself, so fewer model calls are needed. It is used only when it is accurate enough on your spot checks.",
      "- Priority: looks at recommendations you already carried out and how many clicks they gained, and proposes better scoring weights. Proposals are never applied automatically; you decide.",
      "- Related articles: mixes how similar two articles are, which search queries they share and which pages readers actually visit together, and picks the best six for each article. Clicks on the related block (with consent) measure whether it works.",
      "If a model is not better, too new or more than 14 days old, the site quietly uses the rule, and every number says which one made it.",
    ],
  },
  {
    id: "executor",
    kind: "guide",
    section: "Content",
    title: "The code runner (executor), in simple words",
    summary: "How readers' Python code for /python-practice is run safely, away from the website.",
    href: "/admin/practice",
    keywords: ["executor", "sandbox", "code runner", "gvisor", "python practice", "security", "run code", "grading", "tests"],
    diagram: { name: "practice-executor", alt: "The website sends the reader's code and the test inputs to the executor API, which queues the job. The dispatcher starts a fresh sandbox pod with no network, runs the code and reads the outputs. The website compares the outputs with the expected answers and awards progress." },
    body: [
      "Readers on /python-practice can write Python and press Run. Running a stranger's code is risky, so it never runs inside the website.",
      "- The website checks the reader is signed in and within their limits, then sends the code and only the test inputs (never the expected answers) to the executor.",
      "- The executor puts the job in a queue. A dispatcher starts a brand-new, throw-away sandbox for each job.",
      "- The sandbox has no internet, no passwords and no access to anything else. It uses gVisor, a protective layer between the code and the real server. Time, memory, file size and output are all capped.",
      "- The sandbox prints the results; the dispatcher reads them and deletes the sandbox.",
      "- The website compares the outputs with the expected answers itself, so a cheating program cannot fake a pass. Progress, XP and badges are then given exactly once.",
      "Repeated abuse (for example endless loops) blocks the account for 15 minutes. Admins manage problems, roles, topics, the daily challenge, the AI tutor and abuse signals under Python practice.",
    ],
  },
  {
    id: "ml-models",
    kind: "guide",
    section: "SEO agent, AI & ML",
    title: "ML models",
    summary: "Weekly-trained models that replace a rule only when they beat it.",
    href: "/admin/models",
    adminOnly: true,
    keywords: ["machine learning", "ml", "model", "decay", "stl", "clusters", "hdbscan", "intent", "classifier", "priority", "related articles", "override", "rule", "training"],
    diagram: { name: "ml-model-or-rule", alt: "With the override on rule, the rule is used. On model, the model is used if its output is fresh. On auto, the model is used only if an active version beat the rule on held-out data and its output is under 14 days old; otherwise the rule." },
    body: [
      "The SEO agent trains five models each week: content decay (seasonal trend decomposition), query clusters (embeddings and HDBSCAN), a search-intent classifier, learned recommendation priority, and related articles. No ML runs inside a web request; the site reads the stored results.",
      "A new version becomes active only if it beats the current rule on held-out data (and, for some models, after your review). Its output counts as fresh for 14 days.",
      "- Override auto (default): the model when an active version is fresh, otherwise the rule.",
      "- Override rule: always the rule.",
      "- Override model: the model whenever its output is fresh, even if it never beat the rule.",
      "Every number on the site says where it came from: model vN, rule, rule (insufficient history) or rule (stale model output). Labels lets you review training labels; Run now trains outside the schedule.",
    ],
  },
  {
    id: "mcp",
    kind: "guide",
    section: "SEO agent, AI & ML",
    title: "MCP: servers and connected assistants",
    summary: "Connect Claude or MCP Inspector to the SEO tools, choose scopes and revoke access (Settings → Assistants → MCP).",
    href: "/admin/settings/assistants?section=mcp",
    adminOnly: true,
    keywords: ["mcp", "mcp access", "model context protocol", "claude connector", "oauth", "scopes", "revoke", "assistant", "inspector", "public mcp"],
    diagram: { name: "mcp-access", alt: "Claude adds the admin MCP server as a connector, the admin signs in on the consent page and picks scopes, and the token reaches the admin server. It can read, start flows and reject, but never approve, publish, roll back or submit. Admins revoke clients in Settings → MCP. Readers' assistants use the public server without signing in." },
    body: [
      "Two MCP servers expose the platform to AI assistants. The admin server needs OAuth 2.1 with PKCE; the public server is read-only and serves published articles only, without sign-in. Each has a kill switch (ADMIN_MCP_ENABLED, PUBLIC_MCP_ENABLED) and Settings → Assistants → MCP shows whether it is on.",
      "To connect Claude: in Claude, Settings → Connectors → Add custom connector with the admin server URL shown on the page. Claude registers itself, sends you to a consent page on this site, and then appears under Connected clients.",
      "- seo:read: read SEO metrics, keyword opportunities, the review queue, draft diffs, audit issues, flow runs and LLM usage.",
      "- seo:flows: start drafting, sync, audit and report flows (drafts still wait for your approval on the site).",
      "- seo:review:reject: reject drafts and add review notes.",
      "No scope can approve, publish, roll back or submit to search engines. Connected clients shows each client's scopes, who allowed it and when it was last used; Revoke ends its access at once.",
    ],
  },
  {
    id: "skills",
    kind: "guide",
    section: "SEO agent, AI & ML",
    title: "Skills",
    summary: "The writing and checking guidance each AI agent gets: defaults to edit, disable or reset, and your own to add.",
    href: "/admin/automation/skills",
    adminOnly: true,
    keywords: ["skills", "agent skills", "crewai", "crews", "prompt", "instructions", "guidance", "writing style", "how-to", "troubleshooting", "comparison", "news", "security", "promotion", "tags", "intent"],
    body: [
      "Every AI run of the SEO agent is done by a crew of agents: the Editorial crew writes new articles (and Improve), the Optimization crew edits existing ones, the Promotion crew drafts posts and article ideas, the Report crew writes the briefing, and the News desk crew writes news. A skill is a short set of instructions an agent reads before it works, for example how to structure a troubleshooting article or how to cover a security advisory.",
      "- Default skills come with the site. Edit one to change it (it shows Edited), Disable it to stop using it, and Reset to go back to the shipped text. Defaults cannot be deleted.",
      "- Add skill creates your own: give it a name, a one-line description, the agents that get it, and the instructions. Your own skills can be deleted.",
      "- When a skill applies is set by its tags. A skill without tags is used on every run of its agents. With tags, it is used only when the run has one of them. Runs get their tags from data they already have: the article's search intent (from the editorial idea, or from the ML intent model for the item's search queries), where the calendar idea came from (ML query clusters, Google Analytics, Ask the Blog), the recommendation categories being fixed, and the news topics the classifier gave a story. The page lists every tag.",
      "- Changes apply from the next run; nothing running is changed. Each run's log names the skills it used (crew_finished).",
      "- Write skills as instructions to the agent, in plain sentences or a short list. They add to the task's own rules and the style guide; where they differ, the task's rules win.",
    ],
  },
  {
    id: "crewai-console",
    kind: "guide",
    section: "SEO agent, AI & ML",
    title: "CrewAI console: flow runs and logs",
    summary: "Every run of the SEO agent's flows and crews, like GitHub Actions: what is running, what failed and why, each step's log, model calls, cost, and Re-run.",
    href: "/admin/crewai",
    adminOnly: true,
    keywords: ["crewai", "crews", "flows", "runs", "jobs", "logs", "github actions", "jenkins", "build history", "console output", "re-run", "rerun", "cancel", "transcript", "prompt", "tokens", "cost", "failed run", "stage view"],
    body: [
      "The SEO agent does its work in flows (New article, Optimize article, Report, Search Console sync, the news desk and more). Each time a flow runs, the console keeps the run: a number per flow (#12), who or what started it, every step with its time, the log, the cost per agent and model, and what it produced. The history is in the site's database, so it stays readable while the agent is off.",
      "- Overview: runs in the last 24 hours, the success rate and run times of the last 7 days, model cost, what is running now, runs per day, every flow's health and the latest failures. The totals and Runs per day leave out the content flows' housekeeping, which ticks every few minutes and would otherwise hide the real runs; it is still listed under Flows. A flow's health (Healthy, Unstable or Failing, with its success rate) is over its finished runs of the last 7 days, the same days as its run count; its last ten runs are the coloured squares next to it. A rate is never rounded up to 100% while a run failed.",
      "- Runs (all flow runs): every run, newest first, content flow runs included under the content flow's name. Filter by flow, status or trigger (Schedule, Manual, Approval, Another flow, MCP client), or search for #12, a run ID, a draft or target ID, a person or an error. Filters stay in the address, so a filtered list can be shared.",
      "- A run's page shows its status, any errors at the top, the steps on the left and the log grouped by step: a failed step opens by itself. Search the log, choose the level (debug lines such as web requests are hidden at first), show timestamps, copy a link to a line (click its number) or download the whole log. While a run is going the log follows it live.",
      "- Model calls: each call an agent makes is a log line with its tokens, cost and time. Transcript shows the exact system prompt, prompt and answer, kept while Run history → transcripts is on (Settings → SEO agent → Run history; on by default, kept 14 days). Log lines are kept 90 days by default; runs, steps and cost are kept.",
      "- Re-run starts the same flow again with the same inputs, or with changed inputs (checked by the flow before it starts); the new run is a manual run in your name and opens at once. Cancel run stops a queued or running run. Drafting runs (New article, Optimize article) are regenerated from the review queue instead, Publish runs start only from an approval, and per-story news runs are retried from their content flow run's page.",
      "- Cost by agent and model lists each agent's calls, tokens, model time and cost. Runs it started lists the runs a run fanned out (Weekly recommendations starts one Optimize article run per article), and Started by links back.",
      "A demo account can look at everything but not re-run or cancel. Runs that happened before the console existed have a number but no steps or log.",
      "The console's other tabs: Flows (your content flows, custom flows and the built-in ones; start any flow with your own parameters; Schedules says when each runs), Crews (agents and prompts, versions and Test run) and Import / export. There is no Jobs tab since 2026-11-23: a crew job is a content flow. Each has its own entry in this guide.",
    ],
  },
  {
    id: "crewai-flows",
    kind: "guide",
    section: "SEO agent, AI & ML",
    title: "CrewAI console: flows and Run with parameters",
    summary: "Every flow in one list (content flows, custom flows, built-in flows), each with its settings or parameters, schedule and run history, and a Run with parameters button like Jenkins' Build with Parameters.",
    href: "/admin/crewai/flows",
    adminOnly: true,
    keywords: ["flows", "jobs", "run with parameters", "build with parameters", "jenkins", "start a flow", "manual run", "inputs", "parameters", "run now"],
    body: [
      "Flows lists every flow in three parts (the chips at the top show one part): Content flows, which find and draft content on their own schedules (Content flows in this guide); Custom flows, built from your crews; and Built-in flows by group: what each does, when it is scheduled, and how its last run went. Open a built-in flow for its page: its parameters (name, type, default), its schedules, the crew it runs, and its last twenty runs. Runs and Schedules are at the top.",
      "- Run with parameters opens a form built from the flow's own inputs: text, numbers, yes/no, choices and lists each get a field; leave one empty to use the flow's default. Edit as JSON shows the same inputs as one JSON object. The flow checks them before it starts and says what is wrong if they do not fit.",
      "- The run is a manual run in your name and opens at once; if a run of the same flow for the same target is already going, that one opens instead.",
      "- Not started from here: New article and Optimize article (regenerate them from the review queue), Publish (only from an approval) and per-story news runs (retry them from their content flow run's page). The content flows' housekeeping runs on its schedule; use Run now on its schedule to start it by hand.",
      "The button is greyed out while the SEO agent is off; the list and history stay readable.",
      "Custom flows (New custom flow): steps in order. A crew step runs one of your custom crews with inputs from the flow ({input.name}) and earlier steps ({steps.name}); a condition checks a value (contains, does not contain, at least N characters) and otherwise stops the flow or skips the next step; a draft step puts a draft in the review queue (blog or news). There is no step that publishes: a person approves every draft. Test run runs everything except the draft step; Run now creates the draft. To run one on a schedule, add a schedule for the Custom flow with its inputs (AI & SEO → Flows → Schedules). Deleting a flow removes its schedules.",
    ],
  },
  {
    id: "crewai-schedules",
    kind: "guide",
    section: "SEO agent, AI & ML",
    title: "Schedules",
    summary: "When each built-in flow and custom flow runs (AI & SEO → Flows → Schedules): cron and time zone, inputs, pause, run now, reset.",
    href: "/admin/crewai/schedules",
    adminOnly: true,
    keywords: ["schedule", "schedules", "system jobs", "jobs", "custom flow", "cron", "cronjob", "dispatcher", "time zone", "timezone", "pause", "resume", "run now", "weekly", "daily", "monthly"],
    body: [
      "AI & SEO → Flows → Schedules lists when the built-in flows and your custom flows run (from 2026-11-21 to 2026-11-23 the system jobs on the Jobs page). A content flow's own time is set in that content flow.",
      "Each schedule starts one flow at the times its cron expression gives, in its time zone, with the inputs you set (for example report-monthly runs the Report flow with period monthly on the 2nd at 08:00 UTC). One dispatcher checks them and the content flows every minute and starts what is due; the run's trigger is Schedule and it names the schedule (schedule:report-monthly).",
      "- New schedule: a name, the flow, a cron expression (minute hour day month weekday, for example 0 7 * * 1 for Mondays at 07:00), a time zone and the inputs. The next three times are shown in your own time as you type.",
      "- Edit changes the time, time zone, inputs or description. Pause stops a schedule without losing it; Resume starts it again. A new or changed schedule never runs at once for a time that has already passed: its first run is the next time due.",
      "- Run now starts the flow at once with the schedule's inputs, as a manual run in your name; the schedule's times do not change.",
      "- The fifteen built-in schedules (Search Console and GA4 syncs, the audit, weekly recommendations, reports, reindex, the ML models, content flow housekeeping and training, promotion) can be edited, paused and reset to their shipped time, not deleted. Schedules you add can be deleted.",
      "- Last shows how the latest start went: started (with a link to the run), previous run still going (the flow was busy, as before), or not started with the reason (for example inputs the flow refused).",
      "If the SEO agent was down, a time it missed still runs when it is back, if that is within an hour; only the latest missed time runs. The same holds for content flows. Nothing runs unless the dispatcher CronJob is deployed (seo-flow-dispatcher, every minute).",
    ],
  },
  {
    id: "crewai-catalogue",
    kind: "guide",
    section: "SEO agent, AI & ML",
    title: "Crews and flows: categories, tags and filters",
    summary: "File crews and flows under categories and tags, and find them with the same filters on both lists.",
    href: "/admin/crewai/categories",
    adminOnly: true,
    keywords: ["category", "categories", "tag", "tags", "filter", "filters", "search", "organise", "organize", "seo", "content", "automation", "duplicate", "delete", "restore", "switch off"],
    body: [
      "Every crew and every flow is one row of the same list (AI & SEO → Crews, AI & SEO → Flows): the SEO agent's own and the ones you make. There are no built-in, custom, content or SEO kinds any more. Each can be opened, edited, duplicated, switched off or on, deleted and restored from the list's ⋯ menu or its own page.",
      "- Categories (AI & SEO → Categories): add, rename, reorder and remove them. A crew or flow can be in any number. Renaming keeps it on everything filed under it; removing takes it off them. Categories never change how anything runs.",
      "- Tags: free words on a crew or flow (weekly, kubernetes), set in its Details.",
      "- Filters: search by name, description or tag; pick categories and tags (any one matches; the numbers show how many have each); status (on, off, deleted); created or changed recently; the last run (succeeded, failed, running, never run). Sort by name, last change, creation or number of runs. Each filter is a chip you can remove; Clear all resets. The address keeps the filter, so you can bookmark it, and the list remembers it while the tab is open.",
      "- Duplicate makes a copy you can change entirely, switched off until you check it: a crew defined in code is copied from the version it runs; a flow defined in code becomes a flow whose first step starts it, so you can add steps around it; a content flow becomes a new content flow.",
      "- Delete hides a crew or flow and switches it off; its run history stays and the Deleted filter brings it back (Restore). A crew a flow still runs cannot be switched off or deleted.",
    ],
  },
  {
    id: "crewai-crews",
    kind: "guide",
    section: "SEO agent, AI & ML",
    title: "CrewAI console: crews, versions and Test run",
    summary: "Edit a crew's agents and prompts, save them as versions, try them on an earlier run with Test run (like Jenkins Replay), and roll back.",
    href: "/admin/crewai/crews",
    adminOnly: true,
    keywords: ["crew", "crews", "prompt", "prompts", "agent", "role", "goal", "backstory", "instructions", "model", "versions", "rollback", "test run", "replay", "jenkins replay", "prompt engineering"],
    body: [
      "Crews lists the SEO agent's crews (Editorial, Optimization, Report, Promotion, News desk) and which configuration each one runs: a saved version, or the code's defaults. Open a crew to edit it.",
      "- Agents: role, goal, backstory, model, output tokens, iterations and tools. Only tools the crew has in code can be ticked; all of them read, none can publish.",
      "- Tasks: the instructions and, where the code does not read the answer itself, the expected output. Placeholders such as {kind} are filled in at run time. Added by the code shows what every run adds and you cannot change: the data the task works on, the output format the code reads, and the safety rules.",
      "- A field that differs from the code's default says changed; Show changes shows the difference word by word, and Reset to default takes it back.",
      "- Check asks the agent whether it accepts the configuration. Save as new version keeps it as the next version without using it; Save and activate makes the crew run it from its next run. Versions are never changed afterwards, so the history is complete.",
      "- Test run runs the crew once with the prompts on screen, saved or not, on the inputs of an earlier finished run you choose (a New article run for the Editorial crew, a Report run for the Report crew, and so on). It saves nothing anywhere: the test run opens in the console with its log, transcripts, cost and output, and Save as new version there keeps exactly the prompts it ran. Replay with edited prompts on a run's page opens the editor with that run chosen.",
      "- Versions: Open in the editor loads any version; Activate makes it the one the crew runs (also a rollback); Use the code's defaults stops using saved versions. A version written for older code defaults is marked, because the agent was updated since.",
      "Every model call records which version produced it (the prompt version in the transcript and cost tables ends in +v3, or +test for a test run). Test runs cost model tokens like any run and count against the monthly budget.",
      "Custom crews (New crew): make your own crew from agents and tasks. Each agent has a role, goal and backstory, tools from the allowlist only (search the site, read an article, Search Console queries for a topic, the style guide, official documentation) and an optional model (a LiteLLM alias); tasks run in order, each with instructions that may use {input} names and {today}, an expected output, and the earlier tasks it reads (none ticked: the task just before it). The SEO agent checks a crew when you save it; the rules every crew follows (untrusted data stays data, no delegation or code, the token and time caps, LiteLLM's budgets) are added by its code. A custom crew runs in your custom flows; one a flow uses cannot be switched off or deleted.",
    ],
  },
  {
    id: "crewai-config",
    kind: "guide",
    section: "SEO agent, AI & ML",
    title: "CrewAI console: import and export",
    summary: "Download the schedules, crew versions and skills as one JSON file, and import such a file here or on another site after checking what it would change.",
    href: "/admin/crewai/config",
    adminOnly: true,
    keywords: ["import", "export", "backup", "configuration", "json", "copy settings", "migrate", "schedules", "crews", "skills"],
    body: [
      "Export downloads one JSON file with the schedules (by name), each crew's active version and the skills you added or changed. It holds no secrets, IDs or run history, so it can live in the site's repository.",
      "- Import: choose a file and Check it. You see each schedule, crew and skill marked new, changes (with what changes), same, or refused (with the reason) before anything happens. Import then applies the new and changed ones.",
      "- Import only adds and changes. A schedule, version or skill that is not in the file stays as it is: nothing is deleted or paused.",
      "- A crew in the file becomes a new version on this site, checked by the SEO agent first, so the agent must be online to import crews. With Make imported crew versions active ticked, the crews run them from their next run.",
      "- A schedule is matched by name; one whose flow differs from this site's schedule of the same name is refused (rename one of them).",
    ],
  },
  {
    id: "storage",
    kind: "guide",
    section: "Site settings",
    title: "Media & storage",
    summary: "Where media, invoices, backups and the SEO agent's data are stored: Cloudflare R2 or Amazon S3 (Settings → Media & storage).",
    href: "/admin/settings/storage?section=media-storage",
    adminOnly: true,
    keywords: ["r2", "s3", "amazon", "aws", "cloudflare", "storage", "bucket", "media", "uploads", "region"],
    body: [
      "Keys are encrypted at rest and never shown again; leave a secret field empty to keep the stored value.",
      "- Choose the provider: Cloudflare R2 (account ID) or Amazon S3 (region). Then the bucket, an access key ID and secret scoped to that bucket, an optional public media URL (a custom domain or CloudFront, for large files) and an optional API endpoint (an R2 jurisdiction, or an S3-compatible service). Save and test connection checks it before uploads are enabled.",
      "- With Amazon S3, large uploads go from the browser straight to the bucket: its CORS configuration must allow PUT from this site with the Content-Type and Cache-Control headers.",
      "- From the deployment instead: R2_* variables, or S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY (S3_ENDPOINT and S3_PUBLIC_BASE_URL optional). A one-time tool moves media kept in the old S3 bucket of 2026-10 to the configured storage.",
      "- Video destinations: where a generated video can go when an author inserts it: this site's media library, Cloudflare Stream, Mux or Bunny Stream. The editor offers only destinations that are switched on and fully filled in.",
    ],
  },
  {
    id: "email",
    kind: "guide",
    section: "Site settings",
    title: "Email",
    summary: "Outgoing email: SMTP, Mailgun or Amazon SES (Settings → Email).",
    href: "/admin/settings/email?section=email",
    adminOnly: true,
    keywords: ["email", "smtp", "ses", "mailgun", "mail", "invitations", "verification", "sender"],
    body: [
      "Keys are encrypted at rest and never shown again; leave a secret field empty to keep the stored value.",
      "- Choose one provider (SMTP, Mailgun or Amazon SES; there is no automatic failover), the sender name and address and an optional reply-to. SMTP needs host, port (587 STARTTLS, 465 TLS), encryption and credentials; Mailgun a sending domain, region and API key; SES a region and either the server's AWS credentials or access keys stored here. Send a test before relying on it.",
      "Email is needed for sign-up verification, password resets and demo invitations.",
    ],
  },
  {
    id: "users",
    kind: "guide",
    section: "Site settings",
    title: "Managing users",
    summary: "Invite demo users, add accounts with a password, change roles, ban or delete.",
    href: "/admin/users",
    adminOnly: true,
    keywords: ["users", "accounts", "invite", "create user", "add user", "password", "ban", "delete", "role", "demo"],
    body: [
      "- Invite demo users: enter an email; the person gets a link to choose a password (valid 72 hours, Resend invite sends a new one). Needs email set up.",
      "- Add a user with a password: create an account of any role with a password you choose. No email is sent; share the password yourself.",
      "- Change a role in the table and press Save; the person is signed out so the new role applies at once.",
      "- Ban signs a user out and blocks sign-in; Delete removes the account (not possible while they still own posts).",
      "- Members-only articles (how much of a members-only post signed-out readers see; a post can set its own share in the editor) and Profile pictures (upload limits for readers' pictures) are in Settings → Users & access; the page links there.",
    ],
  },

  {
    id: "admin-bar",
    kind: "guide",
    section: "Getting started",
    title: "The admin bar",
    summary: "The dark toolbar at the top of every page while you are signed in as staff.",
    keywords: ["toolbar", "admin bar", "top bar", "edit this page", "shortcut", "quick links", "wordpress", "hide toolbar"],
    body: [
      "While you are signed in as an admin or author, a dark bar stays at the top of every page, on the public site and in the admin. Readers never see it, and cached pages never contain it: your browser draws it after the page loads.",
      "- Dashboard / Visit site: on the site it leads to the admin (its arrow opens a short menu of admin pages); in the admin it leads back to the site.",
      "- New: start a post or a page, or open Media. Admins can also start an invoice or add a user.",
      "- Edit: on a post, page, category, tag or your author page, a link to edit it (authors only for their own posts). In the post or page editor it becomes View, once the post is live.",
      "- Comments, Messages and Review queue show how many items are waiting, like the admin menu.",
      "- Cache (admins): purge this page, clear the page cache, reload content and settings, or purge everything; with Cloudflare set up, also purge everything at Cloudflare or open the custom purge. See Cache.",
      "- Your name: your profile, account settings, Hide toolbar on the site, and Sign out.",
      "Hide toolbar on the site keeps the bar in the admin only, in this browser; Show toolbar on the site brings it back. Signing out removes the bar at once.",
      "The bar is not shown in the editor's previews, in focus mode, or when you print a page.",
    ],
  },

  // Operations
  {
    id: "cache",
    kind: "guide",
    section: "Operations",
    title: "Cache",
    summary: "See the page cache and clear it on every server.",
    href: "/admin/cache",
    adminOnly: true,
    keywords: ["cache", "purge", "clear cache", "flush", "stale", "old page", "refresh", "page cache", "performance", "cache bus", "cloudflare", "cdn", "purge everything", "custom purge", "purge on publish"],
    body: [
      "Public pages are rendered once and served from memory, so readers get them fast. Each server of the site keeps its own copy; the cache bus (Redis/Valkey) carries every clear to all of them.",
      "Publishing, editing or deleting a post or page, and saving settings, menus, categories or integrations, already clears the cache everywhere, and the site renders its pages again in the background within seconds. Without the cache bus the other servers catch up within five minutes.",
      "- Purge this page: removes one address (for example /blog/my-post, or / for the home page) on every server. Also in the admin bar while you look at the page.",
      "- Clear page cache: every page is rendered again on its next visit.",
      "- Reload content & settings: reads posts, pages, categories, menus, appearance and integrations from the database again, and clears the page cache.",
      "- Purge all caches: everything above at once.",
      "The page also shows, for the server that answered, how many pages it holds, the memory they use (PAGE_CACHE_MAX_MB), how often visits were served from the cache, and the last cache actions with who ran them. Every action is also in the Audit log.",
      "Cloudflare: when Cloudflare is in front of the site it keeps its own copies of pages. Save its zone ID and an API token (permission Zone → Cache Purge → Purge, this zone only) in Settings → System → Cloudflare cache, then press Test connection here. From then on Purge this page and Purge all caches also purge Cloudflare, and the Cloudflare card offers Purge everything at Cloudflare and a Custom purge by URLs, prefixes, hostnames or cache tags (one per line).",
      "Purge on publish: publishing, updating, scheduling live, unpublishing or deleting a post, news story, project or page purges Cloudflare's copy of it and of the pages that list it: the home page, the section's listing pages, feeds, its category, tags and author page, the sitemaps and the search index. Appearance, menu, category and tag changes purge everything. It runs a few seconds after the change, in the background; the Cloudflare card shows the last one and whether Cloudflare accepted it. Admin → Cache → Cloudflare settings → Purge Cloudflare when content changes can switch it to everything, or off.",
      "Cloudflare limits how often everything, prefixes, hostnames and tags can be purged (a few times a minute on the Free plan); purging addresses is not limited that way. When Cloudflare refuses, the message says why and the site's own caches are still cleared.",
      "Demo accounts see these tools but cannot run them.",
    ],
  },
  {
    id: "system",
    kind: "guide",
    section: "Operations",
    title: "System status and data sync",
    summary: "Live dependency checks, and every data import run.",
    href: "/admin/system",
    adminOnly: true,
    keywords: ["health", "status", "uptime", "database", "redis", "sync", "import", "google api", "errors", "monitoring", "configure", "seo agent", "degraded"],
    body: [
      "System status runs live checks of every service the site depends on; reload the page (or press Re-run checks) to run them again. The cards at the top count what is down, degraded, not configured and healthy.",
      "Checks are grouped: Core (database, cache, media storage), Publishing (scheduled posts, the editorial calendar, the news desk), SEO & AI (the SEO agent and its failing flows, LiteLLM, Search Console and Google Analytics syncs, ML models), Integrations (email, Turnstile, image generation, social sign-in, payments, breached-password check) and Operations (background jobs, tracing, TLS certificate, backups).",
      "Configure ↗ opens the page where that service is set up in a new tab, so the status page stays open. A service set in the deployment instead (the Kubernetes Secret) names its setting, for example REDIS_URL.",
      "The SEO agent is degraded only while a flow's latest run in the last 24 hours failed; the failing flows and their errors are listed.",
      "Data sync lists every scheduled, manual and backfill run: window, status, rows written, Google API requests, retries and errors. Queued runs start within about 30 seconds.",
      "ML models shows the models trained weekly; a model is only used when it beats its rule on held-out data.",
    ],
  },
  {
    id: "backups",
    kind: "guide",
    section: "Operations",
    title: "Backups",
    summary: "Complete backups of the site (database, files, configuration) in one zip: make, download, verify, restore.",
    href: "/admin/backups",
    adminOnly: true,
    keywords: ["backup", "restore", "export", "download", "zip", "encrypt", "verify", "checksum", "schedule", "retention", "recover", "disaster"],
    body: [
      "A full site backup holds every table of the database, every file the site keeps in its storage bucket (media, images, documents, invoices, reports), the configuration, a manifest and checksums. Database only leaves the files out. Choose one and press Back up now: it runs in the background, and this page shows its progress. When it is finished it has been read back and checked, file by file.",
      "Backups never hold password hashes, sessions, API keys or tokens, and every credential the site stores (storage, email, AI providers…) is replaced by a placeholder. Stored backups are encrypted (AES-256) with a key derived from the server's SETTINGS_ENCRYPTION_KEY: keep that secret safe outside the site. Download gives you a decrypted copy any zip tool opens; keep it private, it holds accounts, comments and messages.",
      "Verify reads a backup back and checks its signature and the checksum of every file. Restore checks it the same way first, backs up the current database, puts back the files the bucket no longer has, then replaces the database's tables in one step (all or nothing). Accounts are never changed or removed (missing ones are added without a password), the audit log only gains entries, and the credentials the site has now stay. Visitors keep seeing the site while it runs.",
      "When backups are made, what a scheduled one holds, how many of each type are kept, a size limit, encryption and the bucket are in Settings → System → Backups. On a site with the SEO agent, a CrewAI schedule of the Website backup flow (AI & SEO → Schedules) can make them instead; the built-in schedule then stands down. How to recover a whole site on a new deployment: docs/BACKUPS.md.",
      "Demo accounts can look at backups but cannot download, make, verify, restore or delete them.",
    ],
  },
  {
    id: "database",
    kind: "guide",
    section: "Operations",
    title: "Database browser",
    summary: "Connection, table sizes, maintenance and a read-only browser.",
    href: "/admin/database",
    adminOnly: true,
    keywords: ["postgres", "sql", "tables", "data", "browse"],
    body: ["See the database connection, table sizes and maintenance tasks, and browse tables read-only. Passwords, tokens and secret settings are always redacted."],
  },
  {
    id: "article-index",
    kind: "guide",
    section: "Operations",
    title: "Article index",
    summary: "Browse the chunks and vectors Ask the Blog and the agents search, read-only.",
    href: "/admin/article-index",
    adminOnly: true,
    keywords: ["article index", "pgvector", "vectors", "embeddings", "chunks", "rag", "search index", "reindex", "lancedb", "browse"],
    body: [
      "The article index is where Ask the Blog and the SEO agents look things up: every published article cut into chunks (a section or a few paragraphs each), and for each chunk a vector from the embeddings model. It lives in PostgreSQL with pgvector, and the SEO agent owns it, so this page reads it through the agent.",
      "At the top: how many chunks and articles the index holds, which embeddings model the agent uses now and its vector size, the vector column and its index, and the table's size. The list shows each article with its number of chunks, the model that made them and when they were last embedded. Filter by title or slug, or search the text of every chunk. Open an article to see its chunks in order, and open a chunk for its full text, the text that was embedded (title and headings in front), its exact-match terms, the first values of its vector and the chunks closest to it.",
      "After the embeddings model changes to one with another vector size, the agent builds a second table beside the live one. A notice shows how far that rebuild has got, and Live table / Rebuild table switch between the two. Until a complete reindex swaps the new table in, Ask the Blog answers with its fallback. Start one in Flows → Reindex if none is running.",
      "Nothing can be edited here: a chunk changed by hand would no longer match its vector, and the next reindex would rewrite it anyway. Change the article and publish it, or run the Reindex flow. Chunks of an article that was unpublished or deleted stay, marked as such, until the next full reindex. This page replaced the LanceDB browser in November 2026; LanceDB is no longer used.",
    ],
  },
  {
    id: "audit",
    kind: "guide",
    section: "Operations",
    title: "Audit log",
    summary: "Every change and every sign-in attempt.",
    href: "/admin/audit",
    adminOnly: true,
    keywords: ["audit", "history", "log", "security", "sign-in", "login attempts", "who changed"],
    body: ["Every change made from the admin or the API, and every sign-in (successful, failed, rate-limited or blocked by the bot check), with the client IP and browser. Filter it to find who changed what and when."],
  },

  // Account
  {
    id: "profile",
    kind: "guide",
    section: "Account",
    title: "Author profile",
    summary: "The public profile shown on your posts.",
    href: "/admin/profile",
    keywords: ["profile", "bio", "author page", "avatar", "byline"],
    body: ["Your author profile is the public page shown on your posts (at /authors/your-slug). Create it if you do not have one, and keep the bio and links up to date."],
  },
  {
    id: "api-keys",
    kind: "guide",
    section: "Account",
    title: "API keys",
    summary: "Manage posts from scripts and automations.",
    href: "/admin/api-keys",
    keywords: ["api", "token", "key", "automation", "script", "integration"],
    body: [
      "Create API keys to manage posts from scripts and automations. A key acts with its owner's permissions; revoke one you no longer need. Demo accounts cannot create keys.",
      "Scopes decide what a key may do: posts:read lists and reads posts, posts:draft creates and edits drafts only, posts:write can also publish, and images:write pushes site images (the files your content refers to as /images/…) to storage. Only an admin can create a key with images:write, because a site image can be part of any page.",
    ],
  },
];

const faq = (id: string, section: GuideSection, title: string, body: string[], extra: Partial<GuideEntry> = {}): GuideEntry => ({
  id,
  kind: "faq",
  section,
  title,
  summary: body[0]!,
  body,
  ...extra,
});

const faqs: GuideEntry[] = [
  faq("faq-menu-moved", "Getting started", "The menu is arranged differently. Where did a page go?", [
    "Every page is still there, at the same address; only the grouping changed. Type its name in Filter menu at the top of the menu to find it.",
    "- Categories, Tags, the Editorial calendar, the Review queue and Promotion are under Posts.",
    "- Comments, Messages and Bookings are under Comments; Payments is under Billing.",
    "- The old Newsroom's pages are under AI & SEO: its jobs are content flows under Flows, their runs under Runs; Content sources, Topics, Profiles & playground and Content analytics under Content. Its settings are in Settings → SEO agent and AI & models (limits, models, quality gates, ranking, log retention, fetching). Old addresses still work.",
    "- The CrewAI console, ML models and Article index are under AI & SEO (Article index replaced LanceDB, whose old address opens it); so are search performance, analytics, keywords, audits, links and reports, in its Traffic, Content and Authority & health parts.",
    "- The site's design is Appearance → Customise. Every setting, including those that were on Integrations, Storage, Email, AI & SEO → Settings, Users, Cache, Payments, Bookings, Backups, Practice, Promotion and Invoices, is under Settings, by category (since November 2026).",
    "- System status (now Site health), Cache, Backups, Database, Data sync and Audit log are under Tools.",
    "- Author profile is Users → Profile, next to API keys. The User manual is Help, at the foot of the menu.",
    "Pin the pages you use most (the star beside each): they are then listed first.",
  ], { href: "/admin", keywords: ["menu", "moved", "missing", "where", "find", "sidebar", "navigation", "reorganised"] }),
  faq("faq-demo-save", "Getting started", "I'm a demo user. Why can't I save anything?", [
    "Demo accounts are read-only by design: you see the admin exactly as the owner does, but every save, publish, delete, send, sync and AI action is refused and nothing is stored.",
    "Ask the site owner for an author or admin account if you need to make changes.",
  ], { keywords: ["demo", "read-only", "save", "denied", "refused", "permission"] }),
  faq("faq-demo-data", "Getting started", "Is the data I see as a demo user real?", [
    "Yes. Demo accounts see the live publication's data, as an admin does. Secrets (keys, passwords, tokens) stay masked everywhere.",
  ], { keywords: ["demo", "real", "data", "privacy"] }),
  faq("faq-cant-see-page", "Getting started", "Why don't I see some pages in the menu?", [
    "Authors only see the pages they can use: content, comments, their profile and API keys. Editorial & AI, Insights, Site settings and Operations are for admins (and read-only demo accounts).",
  ], { keywords: ["missing", "menu", "hidden", "permission", "author"] }),
  faq("faq-publish", "Content", "How do I publish a post?", [
    "Open the post in Admin → Posts, fill in the required fields (title, description, category, content type; sources for news) and press Publish in the editor.",
    "To publish later, schedule it instead. AI-drafted articles are published by approving them in the Review queue.",
  ], { href: "/admin/posts", keywords: ["publish", "go live", "schedule", "post"] }),
  faq("faq-markdown", "Content", "Can I write in Markdown?", [
    "Yes. Markdown is the stored format; switch the editor to Markdown mode at any time and back to Visual without losing anything.",
  ], { href: "/admin/posts", keywords: ["markdown", "md", "source", "html"] }),
  faq("faq-image-delete", "Content", "Why can't I delete an image from the media library?", [
    "A file that is still used by a post cannot be deleted. The media library shows where it is used; remove it from those posts first.",
  ], { href: "/admin/media", keywords: ["delete", "image", "media", "in use"] }),
  faq("faq-ai-publish", "Editorial & AI", "Does AI ever publish on its own?", [
    "No. AI-drafted articles and news wait in the review queues until a person approves them. Assistants connected through MCP can never approve or publish.",
    "The one automatic change is internal linking, when its weekly job is switched on, and it works within strict limits.",
  ], { keywords: ["ai", "automatic", "publish", "claude", "safety", "approve"] }),
  faq("faq-ai-cost", "Editorial & AI", "How is AI spending kept under control?", [
    "LiteLLM holds every LLM budget: a budget for the site's team and one per key (Ask the Blog and the tutor have their own keys), set in LiteLLM and shown under Settings → AI & models → LiteLLM. Content flows keep their image caps on top. AI and paid calls are always explicit actions, never triggered by just viewing a page.",
  ], { keywords: ["cost", "budget", "spend", "money", "ai"] }),
  faq("faq-stale-data", "Insights", "The search or analytics numbers look out of date. Why?", [
    "Search Console data is usually two to three days behind. Check Admin → Data sync for the latest run and its errors; queued runs start within about 30 seconds.",
  ], { href: "/admin/sync", adminOnly: true, keywords: ["stale", "old", "missing", "data", "sync", "delay"] }),
  faq("faq-numbers-differ", "Insights", "Why do backlink counts differ from Google Search Console?", [
    "Backlinks come from DataForSEO's own crawl, not Google's, so their counts differ. Read both as trends.",
  ], { href: "/admin/backlinks", adminOnly: true, keywords: ["backlinks", "different", "mismatch"] }),
  faq("faq-add-user", "Site settings", "How do I add a user?", [
    "Admin → Users. Either invite a demo user by email (they choose their own password), or use “Add a user with a password” to create an account of any role with a password you set and share yourself.",
  ], { href: "/admin/users", adminOnly: true, keywords: ["add user", "create user", "invite", "new account", "password"] }),
  faq("faq-invite-expired", "Site settings", "A demo invitation link expired. What now?", [
    "Press Resend invite on that user's row in Admin → Users for a new 72-hour link, or the person can use Forgot password on the sign-in page.",
  ], { href: "/admin/users", adminOnly: true, keywords: ["invite", "expired", "link", "resend"] }),
  faq("faq-remove-access", "Site settings", "How do I remove someone's access?", [
    "Ban the account, delete it, or change its role in Admin → Users. Each of these signs the person out immediately.",
  ], { href: "/admin/users", adminOnly: true, keywords: ["remove", "revoke", "ban", "access", "sign out"] }),
  faq("faq-email", "Site settings", "Why are emails (invitations, password resets) not arriving?", [
    "Check Settings → Email: outgoing email must be configured. Then check System status for a failing email check, and ask the person to look in their spam folder.",
  ], { href: "/admin/settings/email?section=email", adminOnly: true, keywords: ["email", "not arriving", "reset", "invite", "ses"] }),
  faq("faq-undo-design", "Site settings", "I published an appearance change by mistake. Can I undo it?", [
    "Yes. Appearance keeps a history; roll back to the previous version.",
  ], { href: "/admin/appearance", adminOnly: true, keywords: ["undo", "rollback", "revert", "design", "theme"] }),
  faq("faq-who-changed", "Operations", "How do I find out who changed something?", [
    "Admin → Audit log records every change made from the admin or the API, and every sign-in, with the person, time, IP and browser.",
  ], { href: "/admin/audit", adminOnly: true, keywords: ["who", "changed", "history", "audit"] }),
  faq("faq-backup", "Operations", "Are passwords included in backups?", [
    "No. Backups exclude password hashes, sessions, API-key hashes and stored credentials. Choose encryption when you create one if it will leave your machine.",
  ], { href: "/admin/backups", adminOnly: true, keywords: ["backup", "password", "security", "encrypt"] }),
  faq("faq-stale-page", "Operations", "I changed something but the site still shows the old version. What do I do?", [
    "Reload the page first: saving already clears the site's cache (and Cloudflare's, when it is set up in Settings → System → Cloudflare cache). If it is still old, open the page and choose Cache → Purge this page in the admin bar (or Admin → Cache). Your browser may also keep a page for a while: try a private window.",
  ], { href: "/admin/cache", adminOnly: true, keywords: ["old", "stale", "cache", "not updating", "purge", "refresh"] }),
  faq("faq-site-down", "Operations", "Something on the site is broken. Where do I look first?", [
    "Admin → System status runs live checks of every dependency. Then check Data sync for failed runs and the Audit log for recent changes.",
  ], { href: "/admin/system", adminOnly: true, keywords: ["broken", "down", "error", "outage", "troubleshoot"] }),
  faq("faq-public-guide", "Getting started", "Can readers see this guide?", [
    "Only if an admin turns on Appearance → General → Public user manual. It then appears at /user-manual for everyone, read-only and without any of your data. It is off by default.",
  ], { href: "/admin/appearance", keywords: ["public", "guide", "manual", "documentation", "share"] }),
  faq("faq-ai-model", "SEO agent, AI & ML", "Which AI models does the CMS use?", [
    "LiteLLM answers every model call (the aliases moks-cms-default for drafting and crews and moks-cms-fast for classifying; which model each points at is set in LiteLLM). Crews, content flows and writing profiles can name another alias. Gemini generates images when configured in Settings → AI & models → Image generation. AI visibility asks the assistants you switch on, each through its own LiteLLM alias.",
  ], { href: "/admin/settings/ai?section=ai", adminOnly: true, keywords: ["model", "litellm", "alias", "claude", "gemini", "openai", "llm"] }),
  faq("faq-ml-trust", "SEO agent, AI & ML", "Can I stop an ML model from being used?", [
    "Yes. Set its override to rule on the ML models page; the site then always uses the rule. auto (the default) only uses a model that beat the rule on held-out data and is less than 14 days old.",
  ], { href: "/admin/models", adminOnly: true, keywords: ["ml", "model", "disable", "override", "rule"] }),
  faq("faq-mcp-revoke", "SEO agent, AI & ML", "How do I disconnect Claude from the admin?", [
    "Settings → Assistants → MCP → Connected clients → Revoke on its row. The token stops working at once. To switch the whole admin MCP server off, the operator sets ADMIN_MCP_ENABLED=false.",
  ], { href: "/admin/settings/assistants?section=mcp", adminOnly: true, keywords: ["mcp", "revoke", "disconnect", "claude"] }),
  faq("faq-seo-budget", "SEO agent, AI & ML", "How much does the SEO agent spend on AI?", [
    "Every LLM call goes through LiteLLM, and its budgets are the only LLM limit: the site's team budget and each key's (agent, Ask the Blog, web, tutor), set in LiteLLM. A call over one is refused and the flow pauses as \"paused (budget)\". No budget is set until you set one. Settings → AI & models → LiteLLM shows the spend. DataForSEO is not an LLM and keeps its own monthly cap.",
  ], { href: "/admin/settings/ai?section=llm", adminOnly: true, keywords: ["cost", "budget", "spend", "claude", "dataforseo"] }),
  faq("faq-social-login", "Site settings", "Google sign-in says redirect_uri_mismatch. What is wrong?", [
    "The callback URL registered with Google must match the one shown in Settings → Users & access → Social sign-in exactly, including https and the path.",
  ], { href: "/admin/settings/access?section=social", adminOnly: true, keywords: ["google", "oauth", "redirect", "sign-in", "error"] }),
  faq("faq-executor-safe", "Content", "Is it safe to let readers run code on the site?", [
    "Their code runs in a separate, throw-away sandbox with no internet and no access to the website, its database or any passwords, and with strict time and memory limits. The website grades the results itself.",
  ], { href: "/admin/practice", keywords: ["executor", "sandbox", "security", "python", "code"] }),
  faq("faq-crewai", "SEO agent, AI & ML", "What is a “crew” and an “agent”?", [
    "An agent is one AI helper with one job (for example “editor” or “technical reviewer”). A crew is a small team of agents that work one after another on the same task. A flow is the step-by-step recipe that runs the crew and saves its draft.",
  ], { adminOnly: true, keywords: ["crewai", "crew", "agent", "flow"] }),
  faq("faq-ml-why-rule", "SEO agent, AI & ML", "Why does a number say “rule” instead of “model”?", [
    "The model was not used because it has not yet proven better than the rule, does not have enough history for that page, or its results are more than 14 days old. The rule is the safe default.",
  ], { href: "/admin/models", adminOnly: true, keywords: ["ml", "rule", "model", "label", "stale"] }),
  faq("faq-agent-down", "SEO agent, AI & ML", "What happens if the seo-agent stops?", [
    "The website keeps working. Background jobs (syncs, drafts, reports, ML) wait until it is back; Data sync and System status show the problem.",
  ], { href: "/admin/system", adminOnly: true, keywords: ["seo-agent", "down", "outage", "jobs"] }),
  faq("faq-invoice-no-pay-button", "Community", "The client says there is no Pay button on the invoice. Why?", [
    "The Pay button is shown only while the invoice is sent, unpaid and has a working Razorpay payment link.",
    "- Razorpay was not connected when the invoice was sent, or online payment is switched off in Invoices → Settings: the invoice went out without a link. Connect Razorpay (Payments → Razorpay payments), open the invoice and press Create a payment link.",
    "- The link expired or was cancelled in the Razorpay dashboard: open the invoice and press Create a payment link.",
    "- The invoice is already paid or void: its page says so instead.",
    "The client does not need a new email: their link stays the same and shows the button as soon as there is a payment link.",
  ], { href: "/admin/invoices", adminOnly: true, keywords: ["invoice", "pay button", "payment link", "razorpay", "expired", "cannot pay"] }),
  faq("faq-invoice-not-marked-paid", "Community", "The client paid, but the invoice still says sent. What now?", [
    "An invoice is marked paid when Razorpay tells the site: through the webhook, or when the client comes back to the invoice page after paying.",
    "Check that the webhook in the Razorpay dashboard points at this site, has the secret from Payments → Razorpay payments, and includes the events payment_link.paid, payment_link.cancelled and payment_link.expired. Razorpay sends a missed event again for a while.",
    "If the money arrived another way (a bank transfer), open the invoice and press Mark as paid. If Razorpay shows the payment but the invoice is still open, Mark as paid notices the online payment and records it as such.",
  ], { href: "/admin/invoices", adminOnly: true, keywords: ["invoice", "paid", "webhook", "razorpay", "still sent", "unpaid", "mark as paid"] }),
  faq("faq-invoice-change-sent", "Community", "Can I change or delete an invoice after sending it?", [
    "No. A sent invoice keeps its number, its amounts and the business details it was sent with, so what the client received and what you have always match.",
    "To correct it: press Copy to a new draft, fix the copy and send it, then Void the wrong one. The voided invoice stays in the list with its number, and the client's old link shows it as cancelled.",
    "Only a draft that was never sent can be deleted.",
  ], { href: "/admin/invoices", adminOnly: true, keywords: ["invoice", "edit", "change", "delete", "void", "correct", "mistake", "credit note"] }),
  faq("faq-api", "Account", "Can I manage posts from a script?", [
    "Yes. Create an API key in Admin → API keys; it acts with your permissions.",
    "A script can also send a post as its MDX file. A new post arrives as a draft, a post that is still a draft is updated, and a published post is left alone: you review and publish in Admin → Posts.",
  ], { href: "/admin/api-keys", keywords: ["api", "script", "automation", "key", "mdx", "file", "push", "ci"] }),
  faq("faq-site-images", "Account", "How do images from the site's repository reach the site?", [
    "Files under public/images/ in the site's repository are pushed to storage (Cloudflare R2) with an API key that has the images:write scope, and are then served at the same /images/… address as before. No build or restart is needed.",
    "A PNG is stored as lossless WebP, about half the size with the same pixels. Keep writing the .png path in your content: pages load the smaller file, and the .png address still answers for social cards and old links.",
    "Pushing a changed file to the same path replaces the image on every page that uses it.",
  ], { href: "/admin/api-keys", adminOnly: true, keywords: ["images", "diagram", "svg", "png", "webp", "r2", "storage", "push", "api"] }),
];

export const GUIDE: GuideEntry[] = [...guides, ...faqs];

/**
 * Where the manual lives: the staff copy inside the admin and the public copy (Appearance → General →
 * Public user manual). Every entry has its own page at <base>/<id>; <base>/print is the whole manual on one page.
 */
export const GUIDE_ADMIN_BASE = "/admin/user-manual";
export const GUIDE_PUBLIC_BASE = "/user-manual";
/** Path segments under the manual that are pages of their own, so no entry may use them as its id. */
export const GUIDE_RESERVED_IDS: readonly string[] = ["print"];

export const guideArticlePath = (base: string, id: string) => `${base}/${id}`;

const pathOf = (href: string) => href.split(/[?#]/)[0]!;

export type GuideTocSection = { section: GuideSection; guides: GuideEntry[]; faqs: GuideEntry[] };

/** The contents: sections in the order of GUIDE_SECTIONS; inside one, its guides, then its questions. */
export function guideToc(entries: GuideEntry[]): GuideTocSection[] {
  return GUIDE_SECTIONS.map((section) => ({
    section,
    guides: entries.filter((e) => e.section === section && e.kind === "guide"),
    faqs: entries.filter((e) => e.section === section && e.kind === "faq"),
  })).filter((s) => s.guides.length + s.faqs.length > 0);
}

/** Every entry in reading order, which is the order of the contents. */
export function guideReadingOrder(entries: GuideEntry[]): GuideEntry[] {
  return guideToc(entries).flatMap((s) => [...s.guides, ...s.faqs]);
}

/** The entries before and after `id` in reading order (for the previous / next links). */
export function guideNeighbours(entries: GuideEntry[], id: string): { previous: GuideEntry | undefined; next: GuideEntry | undefined } {
  const order = guideReadingOrder(entries);
  const i = order.findIndex((e) => e.id === id);
  return i < 0 ? { previous: undefined, next: undefined } : { previous: order[i - 1], next: order[i + 1] };
}

/** What to read next: entries about the same admin page first, then the rest of the section, in reading order. */
export function guideRelated(entries: GuideEntry[], entry: GuideEntry, limit = 6): GuideEntry[] {
  const others = guideReadingOrder(entries).filter((e) => e.id !== entry.id);
  const page = entry.href ? pathOf(entry.href) : null;
  const samePage = page ? others.filter((e) => e.href && pathOf(e.href) === page) : [];
  const sameSection = others.filter((e) => e.section === entry.section && !samePage.includes(e));
  return [...samePage, ...sameSection].slice(0, limit);
}

/** Whether a settings group (user-guide-settings.ts) describes the admin page this entry is about. */
export function sameAdminPage(entry: GuideEntry, href: string): boolean {
  return Boolean(entry.href) && pathOf(entry.href!) === pathOf(href);
}

/** The entries a signed-in role may read: authors do not get admin-only pages (demo accounts read as admins). */
export function guideFor(isAdmin: boolean): GuideEntry[] {
  return isAdmin ? GUIDE : GUIDE.filter((e) => !e.adminOnly);
}

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

/** Entries matching every word of `query` (in title, summary, body or keywords), best matches first. */
export function searchGuide(entries: GuideEntry[], query: string, section?: string, kind?: string): GuideEntry[] {
  const words = norm(query).split(/\s+/).filter(Boolean);
  const pool = entries.filter((e) => (!section || e.section === section) && (!kind || e.kind === kind));
  if (!words.length) return pool;
  const scored: { e: GuideEntry; score: number }[] = [];
  for (const e of pool) {
    const title = norm(e.title);
    const keys = norm((e.keywords ?? []).join(" "));
    const text = norm(`${e.summary} ${e.body.join(" ")} ${e.section}`);
    let score = 0;
    let all = true;
    for (const w of words) {
      const s = (title.includes(w) ? 5 : 0) + (keys.includes(w) ? 3 : 0) + (text.includes(w) ? 1 : 0);
      if (!s) {
        all = false;
        break;
      }
      score += s;
    }
    if (all) scored.push({ e, score });
  }
  return scored.sort((a, b) => b.score - a.score).map((x) => x.e);
}
