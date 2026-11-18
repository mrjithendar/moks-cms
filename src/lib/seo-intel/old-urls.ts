/** Old /admin/seo/* paths → their CMS pages (D-86). */
const MOVED: Record<string, string> = {
  "": "/admin",
  settings: "/admin/automation",
  "settings/mcp": "/admin/automation/mcp",
  pages: "/admin/page-insights",
  content: "/admin/content-audit",
  integrations: "/admin/integrations",
};

export function seoRedirectTarget(rest: string[] = []): string {
  const path = rest.join("/");
  if (rest[0] === "articles" && rest[1]) return `/admin/posts/${encodeURIComponent(rest[1])}/insights`;
  if (path in MOVED) return MOVED[path]!;
  const top = ["calendar", "review", "search", "analytics", "recommendations", "keywords", "links", "technical", "reports", "sync", "models"];
  if (rest[0] && top.includes(rest[0])) return `/admin/${rest.map(encodeURIComponent).join("/")}`;
  return "/admin";
}
