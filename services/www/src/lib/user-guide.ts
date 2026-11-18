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
    diagram: { name: "cms-architecture", alt: "Readers and staff reach the Moks CMS web app through the edge. The web app stores content in PostgreSQL, sessions in Redis and media in Cloudflare R2, and sends email. The SEO agent syncs Google data, drafts with Claude and writes drafts and metrics to PostgreSQL." },
    body: [
      "Moks CMS runs the whole publication from one admin: writing and publishing, search and audience data, AI drafting, comments and enquiries, site design and operations.",
      "The menu on the left has one entry for each area of work: Dashboard, Posts, Editorial, Media, Pages, Newsroom, AI room, SEO & insights, Community, Billing, Practice, Appearance, Users, Settings and System. Every entry opens a submenu with its pages. On a computer or tablet, point at an entry (or click it) and its pages open in a panel beside the menu. On a phone, an entry opens in place, the one you are working in is open, and the browser remembers which entries you opened. An entry shows the total of its badges (pending reviews, unread messages, comments to moderate), so nothing that needs attention is hidden.",
      "- Posts: All posts, Add new (the New post page), Categories and Tags. Editorial: the Editorial calendar, the Review queue and Promotion.",
      "- Pages: All pages, Add new (for a New page) and the Hire me page.",
      "- Newsroom: the news desk's Jobs, Run history, Sources, Topics, Profiles & playground, Analytics and Settings.",
      "- AI room: Automation & AI (the SEO agent's flows), ML models, LanceDB and MCP access.",
      "- Community: Comments, Messages and Bookings. Billing: what clients pay you.",
      "- SEO & insights, in three parts: Traffic (Search performance, Visitor analytics, Page insights, Reports), Content (Keywords, Recommendations, Content audit, Internal linking) and Authority & health (Backlinks, AI visibility, Technical health).",
      "- Appearance: Customise opens Appearance & settings; Menus, Homepage and Typography & colours open it at that section.",
      "- Users: All users, Your profile and API keys. Settings: General settings, Integrations, Storage, Email and Advanced settings. System: System status, Backups, Database, Data sync and Audit log.",
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
      "Good places to start: Dashboard, Posts (open one in the editor), Search performance, Content audit, Review queue, Appearance & settings (look at the previews), System status and this guide's FAQ.",
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
      "Settings lists every setting and option of the CMS with what it does and its default value, from Appearance to the SEO agent, Advanced settings and MCP scopes.",
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
    keywords: ["plan", "schedule", "pipeline", "ideas", "workflow", "generate draft", "improve", "unscheduled", "delete"],
    body: [
      "Every item is Unscheduled, Scheduled or Published. The tabs at the top show each with its count; the filters narrow the list by source, draft state, category and cluster, search titles, and sort by date, priority, title or newest.",
      "Each item has an arrow before its title: expand it to edit the brief and act on it, collapse it to scan the list.",
      "The draft is checked first: an item linked to a post shows that draft; a post with the same title (a draft you wrote, or an article already published) is linked by itself; a link to a deleted or trashed post is cleared. With no draft and nothing published, the item offers Generate draft.",
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
      "Claude drafts improvements and new articles; they wait here for a person. Nothing goes live until you approve an article.",
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
    title: "News desk",
    summary: "Jobs that find, rank and draft source-grounded news for review.",
    href: "/admin/news",
    adminOnly: true,
    keywords: ["news", "sources", "feeds", "jobs", "topics", "profiles", "budget", "cost"],
    body: [
      "The news desk is the Newsroom menu. News jobs discover stories from trusted sources, rank them and draft news grounded in those sources. Nothing publishes without your approval.",
      "- News sources: the feeds and official APIs the desk reads (robots.txt honoured, paywalled sites refused).",
      "- News topics: map news topics to the CMS's categories; your corrections train the classifier weekly.",
      "- News profiles & playground: versioned writing and image styles; proposed versions need your approval.",
      "- News run history and News analytics: every run with its cost and errors, and how published news performs.",
      "- News settings: global spending caps on top of each job's own budget.",
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
    keywords: ["social", "share", "linkedin", "marketing", "distribution"],
    body: ["Promotion suggests where each published article is worth sharing, drafts posts for you to edit and post yourself, and suggests new article ideas that already have an audience. Nothing is posted automatically."],
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
    title: "Reports",
    summary: "Weekly and monthly reports with CSV and printable versions.",
    href: "/admin/reports",
    adminOnly: true,
    keywords: ["report", "weekly", "monthly", "csv", "pdf", "export", "print"],
    body: ["Weekly (last full Monday–Sunday) and monthly (last full month) reports, compared with the previous period. Export as CSV, open a printable page, or download a designed PDF when one has been generated."],
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
      "- Bookings: meetings booked through Cal.com from the Hire me page. Reschedule or cancel them in Cal.com.",
      "- Payments: paid calls from the Hire me page (Razorpay). Refunds and settlements are handled in the Razorpay dashboard.",
      "The Hire me page itself is configured under Appearance & settings. Bills you send to clients are under Invoices.",
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
    title: "Appearance & settings",
    summary: "Customise the public site with drafts, previews, history and rollback.",
    href: "/admin/appearance",
    adminOnly: true,
    keywords: ["theme", "design", "colours", "colors", "fonts", "logo", "header", "footer", "menu", "navigation", "homepage", "maintenance", "branding"],
    body: [
      "Change the public site without code: general details, branding (logos, favicon, share image), header, navigation menus, footer, typography and colours (with live contrast ratios), the homepage sections, blog listings and the Hire me page.",
      "Changes go into a private draft that you preview on the real pages, then publish explicitly. History lets you roll back, and settings can be exported and imported.",
      "General settings also turn comments, reader sign-up, the contact form, the public user guide and maintenance mode on or off.",
    ],
  },
  {
    id: "integrations",
    kind: "guide",
    section: "Site settings",
    title: "Integrations",
    summary: "Social sign-in, IndexNow instant indexing and AI image generation.",
    href: "/admin/integrations",
    adminOnly: true,
    keywords: ["google sign-in", "github", "oauth", "social login", "indexnow", "bing", "gemini", "image generation", "client id", "secret"],
    body: [
      "Integrations connects the site to outside services. Secrets are encrypted at rest and never shown again; leave a secret field empty to keep the stored value.",
      "- Social sign-in (Google, GitHub): register the callback URL shown on the page exactly as given with the provider, then paste the client ID and client secret. Each provider can be switched on or off.",
      "- IndexNow: tells Bing and other IndexNow search engines about new and changed pages straight away. The key file is served by the site so search engines can confirm it belongs to you.",
      "- Image generation (Google Gemini): the API key, the Fast image model used by default in the editor, an optional Pro model (better, slower, dearer), the default image size and the largest size authors may pick (caps cost).",
      "Analytics, ads and search-engine verification tokens are under Advanced settings; Search Console, GA4 and DataForSEO connections are under Automation & AI.",
    ],
  },
  {
    id: "automation",
    kind: "guide",
    section: "SEO agent, AI & ML",
    title: "Automation & AI settings",
    summary: "Data sources, schedules, scoring, drafting, crawler and reports for the SEO agent.",
    href: "/admin/automation",
    adminOnly: true,
    keywords: ["automation", "seo settings", "schedules", "cron", "scoring", "weights", "thresholds", "budget", "claude", "drafts", "crawler", "reports", "dataforseo", "ai visibility"],
    body: [
      "Automation & AI shows the search and analytics connections, Claude usage, ML models and Ask the Blog, then the settings by area. Every saved change is audit-logged.",
      "- Data sources: which Google properties are read, how far back and how long data is kept; DataForSEO for search volume, difficulty, live rankings and backlinks.",
      "- Schedules: when each job runs (UTC; weekday 0 = Sunday).",
      "- Scoring & rules: the weights and thresholds that find and rank recommendations.",
      "- Content & links: keyword opportunities, internal-linking limits and search-engine submission.",
      "- AI & drafts: Claude drafting (always stops at human review), its monthly budget, the optional explanation model and AI visibility.",
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
      "Rules and ML models turn that data into recommendations, reports and alerts, and pick articles worth improving. Drafting flows (optimize_article_flow, new_article_flow) ask Claude crews for a draft within the monthly budget and the rewrite limit.",
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
    diagram: { name: "cms-architecture", alt: "The SEO agent sits next to the web app: it reads Google data, drafts with Claude and saves drafts and numbers in the shared database." },
    body: [
      "The website and the seo-agent are two separate programs. The website shows pages and the admin. The seo-agent is a Python program that does the slow, background work, so the website stays fast.",
      "- It wakes up on a timetable (for example every morning at 06:10 UTC to fetch Search Console data). Pressing Run now in the admin, or asking through MCP, starts the same job straight away.",
      "- It fetches data from Google and DataForSEO and saves it in the same database the website uses.",
      "- It looks at the numbers, finds pages that can do better and asks Claude to write a suggested fix.",
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
      "- Search intent: learns from intent labels Claude gave earlier (and your corrections) to tell “how to”, “what is”, comparison and other searches apart by itself, so fewer Claude calls are needed. It is used only when it is accurate enough on your spot checks.",
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
    title: "MCP access",
    summary: "Connect Claude or MCP Inspector to the SEO tools, choose scopes and revoke access.",
    href: "/admin/automation/mcp",
    adminOnly: true,
    keywords: ["mcp", "model context protocol", "claude connector", "oauth", "scopes", "revoke", "assistant", "inspector", "public mcp"],
    diagram: { name: "mcp-access", alt: "Claude adds the admin MCP server as a connector, the admin signs in on the consent page and picks scopes, and the token reaches the admin server. It can read, start flows and reject, but never approve, publish, roll back or submit. Admins revoke clients on MCP access. Readers' assistants use the public server without signing in." },
    body: [
      "Two MCP servers expose the platform to AI assistants. The admin server needs OAuth 2.1 with PKCE; the public server is read-only and serves published articles only, without sign-in. Each has a kill switch (ADMIN_MCP_ENABLED, PUBLIC_MCP_ENABLED) and the page shows whether it is on.",
      "To connect Claude: in Claude, Settings → Connectors → Add custom connector with the admin server URL shown on the page. Claude registers itself, sends you to a consent page on this site, and then appears under Connected clients.",
      "- seo:read: read SEO metrics, keyword opportunities, the review queue, draft diffs, audit issues, flow runs and LLM usage.",
      "- seo:flows: start drafting, sync, audit and report flows (drafts still wait for your approval on the site).",
      "- seo:review:reject: reject drafts and add review notes.",
      "No scope can approve, publish, roll back or submit to search engines. Connected clients shows each client's scopes, who allowed it and when it was last used; Revoke ends its access at once.",
    ],
  },
  {
    id: "storage",
    kind: "guide",
    section: "Site settings",
    title: "Storage",
    summary: "Where media, invoices, backups and the SEO agent's data are stored (Cloudflare R2).",
    href: "/admin/storage",
    adminOnly: true,
    keywords: ["r2", "s3", "storage", "bucket", "media", "uploads"],
    body: [
      "Keys are encrypted at rest and never shown again; leave a secret field empty to keep the stored value.",
      "- Media storage (Cloudflare R2): account ID, bucket, an access key ID and secret scoped to that bucket, an optional public media URL (a custom domain for large files) and an optional API endpoint for EU/FedRAMP buckets. A one-time tool moves existing media from S3 to R2.",
    ],
  },
  {
    id: "email",
    kind: "guide",
    section: "Site settings",
    title: "Email",
    summary: "Outgoing email: SMTP, Mailgun or Amazon SES.",
    href: "/admin/email",
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
    ],
  },
  {
    id: "advanced",
    kind: "guide",
    section: "Site settings",
    title: "Advanced settings",
    summary: "Lower-level options for operators.",
    href: "/admin/advanced",
    adminOnly: true,
    keywords: ["advanced", "configuration", "options"],
    body: ["Advanced settings holds lower-level site options. Change these only when you know what a setting does; each page section explains its options."],
  },

  // Operations
  {
    id: "system",
    kind: "guide",
    section: "Operations",
    title: "System status and data sync",
    summary: "Live dependency checks, and every data import run.",
    href: "/admin/system",
    adminOnly: true,
    keywords: ["health", "status", "uptime", "database", "redis", "sync", "import", "google api", "errors", "monitoring"],
    body: [
      "System status runs live checks of every service the site depends on; reload the page to run them again.",
      "Data sync lists every scheduled, manual and backfill run: window, status, rows written, Google API requests, retries and errors. Queued runs start within about 30 seconds.",
      "ML models shows the models trained weekly; a model is only used when it beats its rule on held-out data.",
    ],
  },
  {
    id: "backups",
    kind: "guide",
    section: "Operations",
    title: "Backups",
    summary: "Zip backups of content and configuration.",
    href: "/admin/backups",
    adminOnly: true,
    keywords: ["backup", "restore", "export", "download", "zip", "encrypt"],
    body: [
      "Create zip backups of content and configuration, encrypted if you choose. Backups exclude password hashes, sessions, API-key hashes and stored credentials.",
      "Restore replaces posts, pages, categories, comments, media records, redirects and Appearance settings with a stored backup, after saving the current state as a new backup. A post or category that is also in the backup is updated in place, so its SEO drafts, audits and news topics stay. An account the site no longer has is recreated as a reader without a password, whatever role it had in the backup: give staff their roles back in Users.",
      "Demo accounts cannot download backups.",
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
    id: "lancedb",
    kind: "guide",
    section: "Operations",
    title: "LanceDB browser",
    summary: "Browse the SEO agent's LanceDB tables and edit or delete single rows.",
    href: "/admin/lancedb",
    adminOnly: true,
    keywords: ["lancedb", "vectors", "embeddings", "memory", "crewai", "tables", "browse", "edit"],
    body: [
      "LanceDB is the vector store the SEO agent keeps on Cloudflare R2. Table article_chunks is a copy of the article index (every published article's chunks and their vectors), rewritten after each reindex. Pick a table to page through its rows; long text and vectors are shortened in the list.",
      "Edits to article_chunks last only until the next reindex rewrites it: change the article instead.",
      "Open a row to edit its text, number, true/false or date columns, or to delete it. Each change touches exactly one row, chosen by a key column whose value must be unique; vectors are read-only. Every change is a new table version and is recorded in the audit log.",
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
    "- Categories and Tags are under Posts; the Editorial calendar, the Review queue and Promotion are under Editorial.",
    "- Comments, Messages and Bookings are under Community; Payments is under Billing.",
    "- The news desk's pages are under Newsroom; Automation & AI, ML models, LanceDB and MCP access are under AI room.",
    "- Search performance, analytics, keywords, audits, links and reports are under SEO & insights.",
    "- Appearance & settings is Appearance → Customise; its General section is also Settings → General.",
    "- Integrations, Storage, Email and Advanced settings are under Settings; System status, Backups, Database, Data sync and Audit log are under System.",
    "- Author profile is Users → Your profile, next to API keys. The User manual is Help, at the foot of the menu.",
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
    "The news desk has global caps on top of each job's budget, and Automation & AI shows Claude usage. AI and paid calls are always explicit actions, never triggered by just viewing a page.",
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
    "Check Admin → Settings → Email: outgoing email must be configured. Then check System status for a failing email check, and ask the person to look in their spam folder.",
  ], { href: "/admin/email", adminOnly: true, keywords: ["email", "not arriving", "reset", "invite", "ses"] }),
  faq("faq-undo-design", "Site settings", "I published an appearance change by mistake. Can I undo it?", [
    "Yes. Appearance & settings keeps a history; roll back to the previous version.",
  ], { href: "/admin/appearance", adminOnly: true, keywords: ["undo", "rollback", "revert", "design", "theme"] }),
  faq("faq-who-changed", "Operations", "How do I find out who changed something?", [
    "Admin → Audit log records every change made from the admin or the API, and every sign-in, with the person, time, IP and browser.",
  ], { href: "/admin/audit", adminOnly: true, keywords: ["who", "changed", "history", "audit"] }),
  faq("faq-backup", "Operations", "Are passwords included in backups?", [
    "No. Backups exclude password hashes, sessions, API-key hashes and stored credentials. Choose encryption when you create one if it will leave your machine.",
  ], { href: "/admin/backups", adminOnly: true, keywords: ["backup", "password", "security", "encrypt"] }),
  faq("faq-site-down", "Operations", "Something on the site is broken. Where do I look first?", [
    "Admin → System status runs live checks of every dependency. Then check Data sync for failed runs and the Audit log for recent changes.",
  ], { href: "/admin/system", adminOnly: true, keywords: ["broken", "down", "error", "outage", "troubleshoot"] }),
  faq("faq-public-guide", "Getting started", "Can readers see this guide?", [
    "Only if an admin turns on Appearance & settings → General → Public user manual. It then appears at /user-manual for everyone, read-only and without any of your data. It is off by default.",
  ], { href: "/admin/appearance", keywords: ["public", "guide", "manual", "documentation", "share"] }),
  faq("faq-ai-model", "SEO agent, AI & ML", "Which AI models does the CMS use?", [
    "Claude drafts and classifies for the SEO agent (the models are set under Automation & AI → AI & drafts; empty uses the deployment's defaults). Gemini generates images when configured in Integrations. AI visibility asks the assistants you switch on.",
  ], { href: "/admin/automation", adminOnly: true, keywords: ["model", "claude", "gemini", "openai", "llm"] }),
  faq("faq-ml-trust", "SEO agent, AI & ML", "Can I stop an ML model from being used?", [
    "Yes. Set its override to rule on the ML models page; the site then always uses the rule. auto (the default) only uses a model that beat the rule on held-out data and is less than 14 days old.",
  ], { href: "/admin/models", adminOnly: true, keywords: ["ml", "model", "disable", "override", "rule"] }),
  faq("faq-mcp-revoke", "SEO agent, AI & ML", "How do I disconnect Claude from the admin?", [
    "Admin → MCP access → Revoke on its row. The token stops working at once. To switch the whole admin MCP server off, the operator sets ADMIN_MCP_ENABLED=false.",
  ], { href: "/admin/automation/mcp", adminOnly: true, keywords: ["mcp", "revoke", "disconnect", "claude"] }),
  faq("faq-seo-budget", "SEO agent, AI & ML", "How much does the SEO agent spend on AI?", [
    "Drafting stops at the monthly budget in Automation & AI → AI & drafts (0 uses the deployment's ceiling, by default $15). DataForSEO and AI visibility have their own monthly caps; a run stops before a call that would cross one.",
  ], { href: "/admin/automation", adminOnly: true, keywords: ["cost", "budget", "spend", "claude", "dataforseo"] }),
  faq("faq-social-login", "Site settings", "Google sign-in says redirect_uri_mismatch. What is wrong?", [
    "The callback URL registered with Google must match the one shown in Admin → Integrations exactly, including https and the path.",
  ], { href: "/admin/integrations", adminOnly: true, keywords: ["google", "oauth", "redirect", "sign-in", "error"] }),
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
    "- Razorpay was not connected when the invoice was sent, or online payment is switched off in Invoices → Settings: the invoice went out without a link. Connect Razorpay (Advanced settings → Razorpay payments), open the invoice and press Create a payment link.",
    "- The link expired or was cancelled in the Razorpay dashboard: open the invoice and press Create a payment link.",
    "- The invoice is already paid or void: its page says so instead.",
    "The client does not need a new email: their link stays the same and shows the button as soon as there is a payment link.",
  ], { href: "/admin/invoices", adminOnly: true, keywords: ["invoice", "pay button", "payment link", "razorpay", "expired", "cannot pay"] }),
  faq("faq-invoice-not-marked-paid", "Community", "The client paid, but the invoice still says sent. What now?", [
    "An invoice is marked paid when Razorpay tells the site: through the webhook, or when the client comes back to the invoice page after paying.",
    "Check that the webhook in the Razorpay dashboard points at this site, has the secret from Advanced settings → Razorpay payments, and includes the events payment_link.paid, payment_link.cancelled and payment_link.expired. Razorpay sends a missed event again for a while.",
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
 * Where the manual lives: the staff copy inside the admin and the public copy (Appearance & settings → General →
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
