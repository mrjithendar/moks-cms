/**
 * Where an old admin address lives now. Bookmarks, notification e-mails and links the agent made earlier
 * (moks-seo-agent app/mcp/news_tools.py) keep working through two catch-all pages:
 *
 * - the old Newsroom, /admin/news/* (until 2026-11-21): app/admin/news/[[...path]]/page.tsx;
 * - the crew jobs, /admin/crewai/jobs/* (2026-11-21 to 2026-11-23): app/admin/crewai/jobs/[[...path]]/page.tsx.
 *
 * Since 2026-11-23 AI & SEO has flows and crews only. A crew job is a content flow (still a `news_jobs` row): the list
 * is AI & SEO → Flows, the editor /admin/crewai/flows/content/<id>, its runs are flow runs (a content flow's run has
 * the same id as its flow run), and the built-in flows' schedules ("system jobs") are /admin/crewai/schedules.
 *
 * Pure (no I/O), so the redirects and their test share it.
 */

const SEGMENT = /^[A-Za-z0-9-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FLOW = /^[a-z][a-z0-9_]{2,39}_flow$/;
const STATUS = /^[a-z_]{2,20}$/;

/** The content flows' on/off switch on the Flows page (components/news/JobsSwitch.tsx). */
export const CONTENT_SWITCH = "/admin/crewai/flows#content-switch";

const withQuery = (path: string, q: Record<string, string | null>) => {
  const p = new URLSearchParams(Object.entries(q).filter((e): e is [string, string] => Boolean(e[1])));
  return p.size ? `${path}?${p}` : path;
};

/** The runs list for an old job runs filter: one content flow's runs, or every content flow run. */
function runsTarget(query: URLSearchParams): string {
  const job = query.get("job");
  const status = query.get("status");
  const keep = status && STATUS.test(status) ? status : null;
  if (job && UUID.test(job)) return withQuery("/admin/crewai/runs", { content: job.toLowerCase(), status: keep });
  return withQuery("/admin/crewai/runs", { flow: "news_job_flow", status: keep });
}

/** The new address for an old crew jobs path (segments after /admin/crewai/jobs) and query string. */
export function crewJobsTarget(path: readonly string[], query: URLSearchParams = new URLSearchParams()): string {
  const [first, second] = path;
  if (first === undefined) {
    const kind = query.get("kind");
    if (kind === "system") {
      const flow = query.get("flow");
      return withQuery("/admin/crewai/schedules", { flow: flow && FLOW.test(flow) ? flow : null });
    }
    return kind === "content" ? "/admin/crewai/flows?kind=content" : "/admin/crewai/flows";
  }
  if (first === "runs") {
    if (second === undefined) return runsTarget(query);
    return UUID.test(second) ? `/admin/crewai/runs/${second.toLowerCase()}` : "/admin/crewai/runs";
  }
  if (first === "new") return "/admin/crewai/flows/content/new";
  if (UUID.test(first)) return `/admin/crewai/flows/content/${first.toLowerCase()}`;
  return "/admin/crewai/flows";
}

/** The new address for an old Newsroom path (segments after /admin/news) and query string. */
export function newsroomTarget(path: readonly string[], query: URLSearchParams = new URLSearchParams()): string {
  const [first, second] = path;
  const keep = (to: string) => (query.size ? `${to}?${query}` : to);
  const id = second && SEGMENT.test(second) ? second : null;
  switch (first) {
    case undefined:
      return "/admin/crewai/flows";
    case "jobs":
      return id ? crewJobsTarget([id]) : "/admin/crewai/flows";
    case "runs":
      return id ? crewJobsTarget(["runs", id]) : runsTarget(query);
    case "sources":
    case "topics":
    case "profiles":
      return `/admin/content/${first}`;
    case "analytics":
      return keep("/admin/content/analytics");
    // The news settings page is gone: the switch is on the Flows page; the rest moved to where it belongs
    // (lib/news/settings-fields.ts says where each value is now).
    case "settings":
      return CONTENT_SWITCH;
    default:
      return "/admin/crewai/flows";
  }
}
