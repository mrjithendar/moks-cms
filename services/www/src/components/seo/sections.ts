/** Search, analytics, calendar and automation pages, for the ⌘K palette (the sidebar is app/admin/layout.tsx). */
export type SectionIcon = "home" | "chart" | "users" | "file" | "inbox" | "bulb" | "key" | "doc" | "link" | "wrench" | "calendar" | "report" | "plug" | "sync" | "cog";
export type Section = { href: string; label: string; icon: SectionIcon; hint: string; badge?: "review" };

export const SEO_GROUPS: { label: string; items: Section[] }[] = [
  {
    label: "Monitor",
    items: [
      { href: "/admin", label: "Dashboard: search & traffic", icon: "home", hint: "KPIs, health score, top movers" },
      { href: "/admin/search", label: "Search performance", icon: "chart", hint: "Search Console clicks, impressions, CTR, position" },
      { href: "/admin/analytics", label: "Visitor analytics", icon: "users", hint: "GA4 sessions and engagement" },
      { href: "/admin/page-insights", label: "Page insights", icon: "file", hint: "Per-page search + analytics" },
    ],
  },
  {
    label: "Act",
    items: [
      { href: "/admin/review", label: "Review queue", icon: "inbox", hint: "Claude-drafted changes waiting for approval", badge: "review" },
      { href: "/admin/recommendations", label: "Recommendations", icon: "bulb", hint: "Evidence-backed opportunities" },
      { href: "/admin/keywords", label: "Keywords", icon: "key", hint: "Striking distance, low CTR, rising, gaps" },
      { href: "/admin/content-audit", label: "Content audit", icon: "doc", hint: "Audit issues per article" },
      { href: "/admin/links", label: "Internal linking", icon: "link", hint: "Link graph, orphans, pending links" },
      { href: "/admin/backlinks", label: "Backlinks", icon: "link", hint: "Referring domains gained and lost (DataForSEO)" },
    ],
  },
  {
    label: "Site",
    items: [
      { href: "/admin/technical", label: "Technical health", icon: "wrench", hint: "Crawl, indexability, structured data" },
      { href: "/admin/calendar", label: "Editorial calendar", icon: "calendar", hint: "Planned and suggested articles" },
      { href: "/admin/promotion", label: "Promotion", icon: "bulb", hint: "Where to share articles, drafted posts, content ideas" },
      { href: "/admin/reports", label: "Reports", icon: "report", hint: "Weekly and monthly reports" },
    ],
  },
  {
    label: "System",
    items: [
      { href: "/admin/integrations", label: "Integrations", icon: "plug", hint: "Search Console, GA4, Claude" },
      { href: "/admin/sync", label: "Data sync", icon: "sync", hint: "Jobs, errors, correlation ids" },
      { href: "/admin/models", label: "ML models", icon: "chart", hint: "Model versions, metrics vs the rules, overrides, labelling" },
      { href: "/admin/automation", label: "Automation & AI", icon: "cog", hint: "Schedules, thresholds, drafts, budget" },
      { href: "/admin/automation/mcp", label: "MCP access", icon: "plug", hint: "AI assistants connected to the SEO tools" },
    ],
  },
];

export const SEO_SECTIONS = SEO_GROUPS.flatMap((g) => g.items.map(({ href, label }) => ({ href, label })));
