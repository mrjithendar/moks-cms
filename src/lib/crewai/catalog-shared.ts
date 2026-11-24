/**
 * The catalogue's types and its filter (lib/crewai/catalog.ts is the server side). Pure and client-safe: the list pages,
 * the filter bar and the API routes read and write the same query string, so a filtered list is a link that can be
 * shared, bookmarked or returned to.
 */

export type CatalogKind = "crew" | "flow";
export type Definition = "code" | "spec" | "content";

export type CatalogItem = {
  kind: CatalogKind;
  key: string;
  label: string;
  description: string;
  objective: string;
  categories: string[];
  tags: string[];
  enabled: boolean;
  disabledReason: string | null;
  /** Where its work is defined: it decides how it is edited and run, never whether it can be. */
  definition: Definition;
  /** Flows: the agent flow that runs it. */
  flowName: string | null;
  /** Flows: how a run may be started from the console (manual, review, approval, schedule, internal). */
  start: string | null;
  contentJobId: string | null;
  spec: Record<string, unknown> | null;
  /** Flows: the crews it runs. */
  crews: string[];
  version: number;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  updatedBy: string | null;
  deletedAt: string | null;
  runs: { total: number; running: number; last: { runId: string; status: string; number: number | null; startedAt: string } | null };
};

export type Facet = { value: string; n: number };
export type CatalogPage = { items: CatalogItem[]; total: number; page: number; pageSize: number; facets: { categories: Facet[]; tags: Facet[] } };
export type Category = { slug: string; label: string; description: string; position: number; crews: number; flows: number };

export const STATUSES = [
  { id: "active", label: "All (not deleted)" },
  { id: "enabled", label: "On" },
  { id: "disabled", label: "Off" },
  { id: "deleted", label: "Deleted" },
] as const;
export const RECENT = [
  { id: "updated_7d", label: "Changed in the last 7 days" },
  { id: "updated_30d", label: "Changed in the last 30 days" },
  { id: "created_7d", label: "Created in the last 7 days" },
  { id: "created_30d", label: "Created in the last 30 days" },
] as const;
export const RUN_STATES = [
  { id: "succeeded", label: "Last run succeeded" },
  { id: "failed", label: "Last run failed" },
  { id: "running", label: "Running now" },
  { id: "never", label: "Never run" },
] as const;
export const SORTS = [
  { id: "name", label: "Name" },
  { id: "updated", label: "Last changed" },
  { id: "created", label: "Created" },
  { id: "runs", label: "Runs" },
] as const;

export type CatalogFilter = {
  q?: string;
  categories?: string[];
  tags?: string[];
  status?: (typeof STATUSES)[number]["id"] | "all";
  recent?: (typeof RECENT)[number]["id"];
  run?: (typeof RUN_STATES)[number]["id"];
  sort?: (typeof SORTS)[number]["id"];
  dir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
  /** Internal (pickers): only rows defined this way. Never offered as a filter: it is not a kind of crew or flow. */
  definition?: Definition;
};

type Params = URLSearchParams | Record<string, string | string[] | undefined>;

const one = (p: Params, k: string): string | undefined => {
  if (p instanceof URLSearchParams) return p.get(k) ?? undefined;
  const v = p[k];
  return Array.isArray(v) ? v[0] : v;
};
const many = (p: Params, k: string): string[] => {
  const raw = p instanceof URLSearchParams ? p.getAll(k) : ([] as string[]).concat(p[k] ?? []);
  return [...new Set(raw.flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean))].slice(0, 20);
};
const pick = <T extends string>(v: string | undefined, list: readonly { id: T }[]): T | undefined => list.find((x) => x.id === v)?.id;

/** The filter in a query string (?q=&category=seo,content&tag=&status=&recent=&run=&sort=&dir=&page=). */
export function parseFilter(p: Params): CatalogFilter {
  const page = Number.parseInt(one(p, "page") ?? "1", 10);
  const size = Number.parseInt(one(p, "size") ?? "25", 10);
  const dir = one(p, "dir");
  const q = (one(p, "q") ?? "").trim().slice(0, 100);
  return {
    ...(q ? { q } : {}),
    categories: many(p, "category").filter((c) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(c)),
    tags: many(p, "tag").map((t) => t.toLowerCase()),
    status: one(p, "status") === "all" ? "all" : (pick(one(p, "status"), STATUSES) ?? "active"),
    recent: pick(one(p, "recent"), RECENT),
    run: pick(one(p, "run"), RUN_STATES),
    sort: pick(one(p, "sort"), SORTS) ?? "name",
    dir: dir === "asc" || dir === "desc" ? dir : undefined,
    page: Number.isFinite(page) && page > 0 ? page : 1,
    pageSize: [10, 25, 50, 100].includes(size) ? size : 25,
  };
}

/** The query string of a filter (without "?"; empty for the default list). */
export function filterQuery(f: CatalogFilter, patch: Partial<CatalogFilter> = {}): string {
  const g = { ...f, ...patch };
  const q = new URLSearchParams();
  if (g.q) q.set("q", g.q);
  if (g.categories?.length) q.set("category", g.categories.join(","));
  if (g.tags?.length) q.set("tag", g.tags.join(","));
  if (g.status && g.status !== "active") q.set("status", g.status);
  if (g.recent) q.set("recent", g.recent);
  if (g.run) q.set("run", g.run);
  if (g.sort && g.sort !== "name") q.set("sort", g.sort);
  if (g.dir) q.set("dir", g.dir);
  if (g.page && g.page > 1) q.set("page", String(g.page));
  if (g.pageSize && g.pageSize !== 25) q.set("size", String(g.pageSize));
  return q.toString();
}

export class CatalogError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issues: string[] = [],
  ) {
    super(message);
  }
}

/** Where to open a crew or a flow. */
export const itemHref = (item: Pick<CatalogItem, "kind" | "key">) => `/admin/crewai/${item.kind === "crew" ? "crews" : "flows"}/${item.key}`;

/** One line on how a flow's runs start, for its page (not a kind of flow: any flow can be edited, copied or switched off). */
export const START_LABELS: Record<string, string> = {
  manual: "by hand or on a schedule",
  review: "from the review queue (its drafts are regenerated there)",
  approval: "only from an approval in the review queue",
  schedule: "on its schedule (Run now on the schedule)",
  internal: "by other flows",
};
