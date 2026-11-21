/**
 * Where an address of the old Newsroom (/admin/news/*, until 2026-11-21) lives now. There is no Newsroom any more: news
 * is one kind of content a crew job writes, managed under AI & SEO. Bookmarks, notification e-mails and links the agent
 * made earlier (moks-seo-agent app/mcp/news_tools.py) keep working through app/admin/news/[[...path]]/page.tsx.
 *
 * Pure (no I/O), so the redirect and its test share it.
 */

const SEGMENT = /^[A-Za-z0-9-]{1,64}$/;

/** The new address for an old Newsroom path (segments after /admin/news) and query string. */
export function newsroomTarget(path: readonly string[], query: URLSearchParams = new URLSearchParams()): string {
  const [first, second] = path;
  const keep = (to: string) => (query.size ? `${to}?${query}` : to);
  const id = second && SEGMENT.test(second) ? second : null;
  switch (first) {
    case undefined:
      return "/admin/crewai/jobs";
    case "jobs":
      return id ? `/admin/crewai/jobs/${id}` : "/admin/crewai/jobs";
    case "runs":
      return id ? `/admin/crewai/jobs/runs/${id}` : keep("/admin/crewai/jobs/runs");
    case "sources":
    case "topics":
    case "profiles":
      return `/admin/content/${first}`;
    case "analytics":
      return keep("/admin/content/analytics");
    // The news settings page is gone: the switch is on the Jobs page; the rest moved to where it belongs
    // (lib/news/settings-fields.ts says where each value is now).
    case "settings":
      return "/admin/crewai/jobs#jobs-switch";
    default:
      return "/admin/crewai/jobs";
  }
}
