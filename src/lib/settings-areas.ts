/**
 * Where every setting of the admin lives: one Settings area (`/admin/settings`), in categories, each category a list of
 * sections (owner, 2026-11-26: "reorganize all CMS settings into one centralized settings experience").
 *
 * A section is one form (or one group of forms that save together) and has ONE address:
 * `/admin/settings/<category>?section=<id>`. Section ids are unique across all categories, so an old address only needs
 * the section id to find its new home (OLD_ADDRESSES below). Feature pages (Users, Cache, Payments, Practice…) keep
 * their records and operations and link here; they hold no settings of their own (docs/SETTINGS.md, rule 2).
 *
 * The forms themselves are unchanged: the same server actions, the same stores (docs/SETTINGS.md section 1). Only where
 * they are drawn changed. The Appearance editor stays the one home of the site's design and identity (one shared draft,
 * preview and Publish); its sections are listed under General, linking to it.
 *
 * Pure and dependency-free: the admin layout and menu (lib/admin-menu.ts), the Settings pages, the redirects, the user
 * guide and the tests import it. What each section draws is in app/admin/settings/sections/index.ts.
 */

export type SettingsCategoryId =
  | "general"
  | "access"
  | "publishing"
  | "email"
  | "storage"
  | "payments"
  | "ai"
  | "agent"
  | "assistants"
  | "seo"
  | "integrations"
  | "practice"
  | "system";

export type SettingsCategory = { id: SettingsCategoryId; label: string; description: string };

export type SettingsSectionDef = {
  id: string;
  label: string;
  category: SettingsCategoryId;
  /** One line under the section's name in the Settings overview and its search. */
  description: string;
  /** More words the Settings search finds it by (field names, products, old page names). */
  keywords?: string[];
  /** Drawn only while this optional module is set up (lib/modules.ts); the SEO agent owns these settings. */
  module?: "seo-agent";
};

export const SETTINGS_PATH = "/admin/settings";

/** In menu and list order. */
export const SETTINGS_CATEGORIES: SettingsCategory[] = [
  { id: "general", label: "General", description: "The site's name, tagline, time zone, contact details and look. They are part of the site's design: edited in Appearance, then published." },
  { id: "access", label: "Users & access", description: "How readers and staff sign in, human verification, members-only articles and profile pictures." },
  { id: "publishing", label: "Content & publishing", description: "Promotion of published articles and instant indexing by search engines." },
  { id: "email", label: "Email", description: "Outgoing email: the provider and sender, and a test message." },
  { id: "storage", label: "Media & storage", description: "Where media, invoices, backups and generated videos are stored." },
  { id: "payments", label: "Payments & bookings", description: "Razorpay for paid calls and invoices, invoice details, and Cal.com bookings." },
  { id: "ai", label: "AI & models", description: "LLM providers and the one LLM budget, AI drafting, ML and retrieval, and image and video generation." },
  { id: "agent", label: "SEO agent", description: "The SEO agent that runs the crews and flows: where it is, its limits, run history, content fetching and the CrewAI configuration repository." },
  { id: "assistants", label: "Assistants", description: "Ask the Blog, and the MCP servers that let AI assistants reach the site." },
  { id: "seo", label: "Search & SEO", description: "Search engine verification, Search Console and GA4, and the SEO settings by area." },
  { id: "integrations", label: "Integrations", description: "Analytics and ads, and the shared Hybrid RAG service." },
  { id: "practice", label: "Practice", description: "Python practice: code execution, quotas, the AI tutor and retention." },
  { id: "system", label: "System", description: "Backups and the Cloudflare cache in front of the site." },
];

const AGENT = "seo-agent" as const;

/** Every section, grouped by category in list order. */
export const SETTINGS_SECTIONS: SettingsSectionDef[] = [
  { id: "site", label: "Site identity", category: "general", description: "Site name, tagline, time zone, date format, contact, features and maintenance mode.", keywords: ["site name", "tagline", "timezone", "time zone", "date format", "contact", "social", "registration", "sign-up", "comments", "maintenance"] },
  { id: "appearance", label: "Appearance", category: "general", description: "Branding, header, menus, footer, typography and colours, homepage, blog, media and the Hire me page.", keywords: ["theme", "logo", "favicon", "colours", "colors", "fonts", "menus", "footer", "homepage", "customise", "customize", "hire me"] },

  { id: "social", label: "Social sign-in", category: "access", description: "Sign-in and registration with Google and GitHub.", keywords: ["oauth", "google", "github", "login", "client id"] },
  { id: "turnstile", label: "Human verification", category: "access", description: "Cloudflare Turnstile on sign-in, sign-up and the contact form.", keywords: ["captcha", "turnstile", "bots", "spam"] },
  { id: "members", label: "Members-only articles", category: "access", description: "How much of a members-only article everyone can read.", keywords: ["paywall", "preview", "members"] },
  { id: "avatars", label: "Profile pictures", category: "access", description: "Upload size and dimension limits for profile pictures.", keywords: ["avatar", "photo", "upload"] },

  { id: "promotion", label: "Promotion", category: "publishing", description: "Channels, subreddits, link tags and limits for promoting articles, and the Reddit connection.", keywords: ["reddit", "utm", "share", "social posts"] },
  { id: "indexnow", label: "IndexNow", category: "publishing", description: "Tell Bing and other IndexNow engines as soon as a post changes.", keywords: ["bing", "yandex", "indexing", "instant indexing"] },

  { id: "email", label: "Provider", category: "email", description: "The email provider and the sender address.", keywords: ["smtp", "ses", "resend", "postmark", "sender", "from address", "mail"] },
  { id: "email-test", label: "Test message", category: "email", description: "Send a test message to check delivery.", keywords: ["test email", "delivery"] },

  { id: "media-storage", label: "Media storage", category: "storage", description: "Cloudflare R2 or Amazon S3 for uploads, invoices, backups and the SEO agent's data.", keywords: ["r2", "s3", "bucket", "uploads", "cdn", "public url"] },
  { id: "video-destinations", label: "Video destinations", category: "storage", description: "Where generated videos can go: the media library, Cloudflare Stream, Mux or Bunny Stream.", keywords: ["stream", "mux", "bunny", "video"] },
  { id: "move-media", label: "Move media to R2", category: "storage", description: "Copy media still read from the old S3 bucket to R2, or roll back.", keywords: ["migration", "s3", "r2"] },

  { id: "razorpay", label: "Razorpay", category: "payments", description: "Keys and webhook secret for paid calls and invoice payments.", keywords: ["payments", "checkout", "webhook", "paid calls"] },
  { id: "invoices", label: "Invoices", category: "payments", description: "Who invoices are from, and what a new invoice starts with.", keywords: ["invoice", "tax", "gst", "vat", "currency", "billing", "business"] },
  { id: "calcom", label: "Cal.com bookings", category: "payments", description: "The webhook secret that lets Cal.com bookings arrive here.", keywords: ["cal.com", "bookings", "calendar", "webhook", "meetings"] },

  { id: "llm", label: "LLM providers & budget", category: "ai", description: "The providers and models the SEO agent may call, and the one LLM budget.", keywords: ["anthropic", "claude", "openai", "gemini", "budget", "spend", "cost", "models", "api key"], module: AGENT },
  { id: "ai", label: "AI & drafts", category: "ai", description: "AI drafting, models and quality gates for content flows, and AI visibility.", keywords: ["drafts", "claude", "writer model", "quality"], module: AGENT },
  { id: "ml", label: "ML & retrieval", category: "ai", description: "Machine-learning models, retrieval and embeddings.", keywords: ["machine learning", "embeddings", "retrieval", "ranking"], module: AGENT },
  { id: "gemini", label: "Image generation", category: "ai", description: "The Google Gemini key and models behind “Generate image”.", keywords: ["gemini", "images", "cover image", "ai images", "api key"] },
  { id: "image-limits", label: "Image limits", category: "ai", description: "How many images authors and the site may generate.", keywords: ["quota", "rate limit", "images"] },
  { id: "video-generation", label: "Video generation", category: "ai", description: "The video model (Veo), clip length and limits.", keywords: ["veo", "video", "quota"] },

  { id: "seo-agent", label: "Connection", category: "agent", description: "Where the SEO agent is, whether it answers, and the services it connects to.", keywords: ["endpoint", "seo agent", "crewai", "status", "connections"] },
  { id: "agent-limits", label: "Agent limits", category: "agent", description: "Timeouts, concurrency and limits of the agent and its content flows.", keywords: ["timeout", "concurrency", "limits"], module: AGENT },
  { id: "runs", label: "Run history", category: "agent", description: "How long runs and logs are kept.", keywords: ["retention", "logs", "history"], module: AGENT },
  { id: "content-fetching", label: "Content fetching", category: "agent", description: "How content sources are fetched for the content flows.", keywords: ["sources", "feeds", "rss", "fetch"], module: AGENT },
  { id: "crewai-repository", label: "Configuration repository", category: "agent", description: "The GitHub repository that holds the CrewAI configuration as files.", keywords: ["github", "git", "crewconfig", "token", "repository"], module: AGENT },

  { id: "ask-the-blog", label: "Ask the Blog", category: "assistants", description: "The reader assistant that answers from the site's articles.", keywords: ["ask", "chat", "assistant", "rag"], module: AGENT },
  { id: "mcp", label: "MCP", category: "assistants", description: "The MCP servers, their connected clients and access.", keywords: ["mcp", "claude desktop", "oauth", "clients", "tools"], module: AGENT },

  { id: "verification", label: "Search engine verification", category: "seo", description: "Google Search Console and Bing Webmaster ownership tokens.", keywords: ["google", "bing", "verification", "meta tag"] },
  { id: "search-console", label: "Search Console & GA4", category: "seo", description: "Whether Search Console and GA4 data can be read.", keywords: ["gsc", "ga4", "google analytics", "service account"] },
  { id: "data", label: "Data sources", category: "seo", description: "Search Console and GA4 properties, PageSpeed, DataForSEO and sync.", keywords: ["property", "pagespeed", "dataforseo", "sync"], module: AGENT },
  { id: "schedules", label: "Schedules", category: "seo", description: "When the SEO jobs run.", keywords: ["cron", "schedule", "daily"], module: AGENT },
  { id: "scoring", label: "Scoring & rules", category: "seo", description: "Scores, thresholds and rules of the SEO checks.", keywords: ["weights", "thresholds", "rules"], module: AGENT },
  { id: "content", label: "Content & links", category: "seo", description: "Content audit, internal linking and URL submission.", keywords: ["internal links", "audit", "url inspection", "indexnow", "submission"], module: AGENT },
  { id: "crawler", label: "Crawler", category: "seo", description: "The technical-health crawler.", keywords: ["crawl", "technical health", "user agent"], module: AGENT },
  { id: "reports", label: "Reports", category: "seo", description: "The SEO-AI reports and who receives them.", keywords: ["email report", "recipients", "weekly"], module: AGENT },

  { id: "analytics", label: "Analytics & ads", category: "integrations", description: "GA4 measurement, AdSense, consent, ads.txt and Reader Revenue Manager.", keywords: ["ga4", "adsense", "ads", "consent", "ads.txt", "reader revenue manager", "google analytics"] },
  { id: "rag", label: "Hybrid RAG", category: "integrations", description: "The shared moks-rag service that indexes published posts.", keywords: ["moks-rag", "rag", "search", "embeddings", "reindex"] },

  { id: "practice", label: "Python practice", category: "practice", description: "Code execution, quotas, the AI tutor, the leaderboard and retention.", keywords: ["executor", "runtimes", "tutor", "quotas", "leaderboard"] },

  { id: "backups", label: "Backups", category: "system", description: "The backup schedule, encryption and storage bucket.", keywords: ["backup", "schedule", "retention", "encryption", "restore"] },
  { id: "cloudflare", label: "Cloudflare cache", category: "system", description: "The Cloudflare zone and token, and what is purged when content changes.", keywords: ["cloudflare", "cache", "purge", "cdn", "zone"] },
];

const BY_ID = new Map(SETTINGS_SECTIONS.map((s) => [s.id, s]));
const CATEGORY_BY_ID = new Map(SETTINGS_CATEGORIES.map((c) => [c.id, c]));

export const settingsSection = (id: string): SettingsSectionDef | undefined => BY_ID.get(id);
export const settingsCategory = (id: string): SettingsCategory | undefined => CATEGORY_BY_ID.get(id as SettingsCategoryId);

/** The address of a category: `/admin/settings/access`. */
export const settingsCategoryHref = (id: SettingsCategoryId) => `${SETTINGS_PATH}/${id}`;

/**
 * The address of a section, and optionally of an element in it: `/admin/settings/access?section=social#…`. Throws for
 * an unknown id, so a link to a section that does not exist fails in the tests, not in front of an admin.
 */
export function settingsHref(id: string, anchor?: string): string {
  const s = BY_ID.get(id);
  if (!s) throw new Error(`Unknown settings section ${id}`);
  return `${settingsCategoryHref(s.category)}?section=${encodeURIComponent(id)}${anchor ? `#${anchor}` : ""}`;
}

/** What a person can see: the module's sections only while it is set up. */
export type SettingsVisibility = { seoAgent: boolean };

export const sectionVisible = (s: SettingsSectionDef, v: SettingsVisibility) => !s.module || (s.module === "seo-agent" && v.seoAgent);

/** The sections of a category, in order, that are visible. */
export const sectionsOf = (category: SettingsCategoryId, v: SettingsVisibility) => SETTINGS_SECTIONS.filter((s) => s.category === category && sectionVisible(s, v));

/** The categories with at least one visible section, each with its visible sections. */
export function visibleCategories(v: SettingsVisibility): (SettingsCategory & { sections: SettingsSectionDef[] })[] {
  return SETTINGS_CATEGORIES.map((c) => ({ ...c, sections: sectionsOf(c.id, v) })).filter((c) => c.sections.length > 0);
}

/** The menu's Settings group: the overview, then one entry per visible category. */
export function settingsMenuItems(v: SettingsVisibility): { href: string; label: string; section: string }[] {
  return [
    { href: SETTINGS_PATH, label: "All settings", section: "Settings" },
    ...visibleCategories(v).map((c) => ({ href: settingsCategoryHref(c.id), label: `${c.label} settings`, section: "Settings" })),
  ];
}

// --- Old addresses ------------------------------------------------------------------------------------------------

/**
 * Settings pages before 2026-11-26 → the section that holds their settings now. Keyed by the old path, then by the old
 * `?section=` (or `?tab=`) value; "" is the page opened without one. The old pages redirect with `movedTo`, so
 * bookmarks, the guide's old links and e-mails still open the right form.
 */
export const OLD_ADDRESSES: Record<string, Record<string, string>> = {
  "/admin/integrations": {
    "": "social",
    social: "social",
    "social-title": "social",
    turnstile: "turnstile",
    indexnow: "indexnow",
    "indexnow-title": "indexnow",
    verification: "verification",
    analytics: "analytics",
    "search-console": "search-console",
    gemini: "gemini",
    "gemini-title": "gemini",
    "image-limits": "image-limits",
    "video-generation": "video-generation",
    rag: "rag",
    "seo-agent": "seo-agent",
  },
  "/admin/storage": { "": "media-storage", media: "media-storage", "video-destinations": "video-destinations", move: "move-media" },
  "/admin/email": { "": "email", provider: "email", test: "email-test" },
  // AI & SEO → Settings (/admin/automation, "Automation & AI" before 2026-11-21) and the ids merged on 2026-11-23.
  "/admin/automation": {
    "": "seo-agent",
    overview: "seo-agent",
    "agent-limits": "agent-limits",
    runs: "runs",
    llm: "llm",
    "llm-providers": "llm",
    "llm-budget": "llm",
    ai: "ai",
    ml: "ml",
    "ask-the-blog": "ask-the-blog",
    mcp: "mcp",
    "mcp-access": "mcp",
    data: "data",
    schedules: "schedules",
    scoring: "scoring",
    content: "content",
    crawler: "crawler",
    reports: "reports",
  },
  "/admin/invoices/settings": { "": "invoices" },
};

/** The element an old merged section id scrolled to, kept so its bookmark still lands on the right card. */
const OLD_ANCHORS: Record<string, string> = { "llm-providers": "llm-providers", "llm-budget": "llm-budget", "mcp-access": "mcp-clients-h" };

/**
 * Where an old settings address now lives, with the rest of its query (?q=, &scope=, ?ok=…) kept. `section` is the old
 * page's `?section=`; an unknown one opens the page's first section.
 */
export function movedTo(oldPath: string, query: Record<string, string | string[] | undefined>): string {
  const map = OLD_ADDRESSES[oldPath];
  if (!map) throw new Error(`Not an old settings address: ${oldPath}`);
  const old = typeof query.section === "string" ? query.section : "";
  const id = map[old] ?? map[""]!;
  const params = new URLSearchParams();
  params.set("section", id);
  for (const [k, v] of Object.entries(query)) {
    if (k === "section" || v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) params.append(k, one);
  }
  const anchor = OLD_ANCHORS[old];
  return `${settingsCategoryHref(BY_ID.get(id)!.category)}?${params.toString()}${anchor ? `#${anchor}` : ""}`;
}

// --- Search -------------------------------------------------------------------------------------------------------

const fold = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

/** Sections whose name, category, description or keywords (and `extra` words, e.g. field labels) contain every word typed. */
export function searchSettings<T extends SettingsSectionDef>(sections: readonly T[], text: string, extra: Record<string, string[]> = {}): T[] {
  const words = fold(text).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return sections.filter((s) => {
    const hay = fold([s.label, CATEGORY_BY_ID.get(s.category)?.label ?? "", s.description, ...(s.keywords ?? []), ...(extra[s.id] ?? [])].join(" "));
    return words.every((w) => hay.includes(w));
  });
}
