/** /admin/seo sections: grouped for the sidebar, flat (SEO_SECTIONS) for older callers. */
export type SectionIcon = "home" | "chart" | "users" | "file" | "inbox" | "bulb" | "key" | "doc" | "link" | "wrench" | "calendar" | "report" | "plug" | "sync" | "cog";
export type Section = { href: string; label: string; icon: SectionIcon; hint: string; badge?: "review" };

export const SEO_GROUPS: { label: string; items: Section[] }[] = [
  {
    label: "Monitor",
    items: [
      { href: "/admin/seo", label: "Overview", icon: "home", hint: "KPIs, health score, top movers" },
      { href: "/admin/seo/search", label: "Search performance", icon: "chart", hint: "Search Console clicks, impressions, CTR, position" },
      { href: "/admin/seo/analytics", label: "Visitor analytics", icon: "users", hint: "GA4 sessions and engagement" },
      { href: "/admin/seo/pages", label: "Page intelligence", icon: "file", hint: "Per-page search + analytics" },
    ],
  },
  {
    label: "Act",
    items: [
      { href: "/admin/seo/review", label: "Review queue", icon: "inbox", hint: "Claude-drafted changes waiting for approval", badge: "review" },
      { href: "/admin/seo/recommendations", label: "Recommendations", icon: "bulb", hint: "Evidence-backed opportunities" },
      { href: "/admin/seo/keywords", label: "Keyword opportunities", icon: "key", hint: "Striking distance, low CTR, rising, gaps" },
      { href: "/admin/seo/content", label: "Content optimization", icon: "doc", hint: "Audit issues per article" },
      { href: "/admin/seo/links", label: "Internal linking", icon: "link", hint: "Link graph, orphans, pending links" },
    ],
  },
  {
    label: "Site",
    items: [
      { href: "/admin/seo/technical", label: "Technical SEO", icon: "wrench", hint: "Crawl, indexability, structured data" },
      { href: "/admin/seo/calendar", label: "Editorial calendar", icon: "calendar", hint: "Planned and suggested articles" },
      { href: "/admin/seo/reports", label: "Reports", icon: "report", hint: "Weekly and monthly reports" },
    ],
  },
  {
    label: "System",
    items: [
      { href: "/admin/seo/integrations", label: "Integrations", icon: "plug", hint: "Search Console, GA4, Claude" },
      { href: "/admin/seo/sync", label: "Sync history", icon: "sync", hint: "Jobs, errors, correlation ids" },
      { href: "/admin/seo/settings", label: "Settings", icon: "cog", hint: "Schedules, thresholds, drafts, budget" },
      { href: "/admin/seo/settings/mcp", label: "MCP access", icon: "plug", hint: "AI assistants connected to the SEO tools" },
    ],
  },
];

export const SEO_SECTIONS = SEO_GROUPS.flatMap((g) => g.items.map(({ href, label }) => ({ href, label })));
