/**
 * CrewAI console reports (D-102): the shapes the web app builds, stores in seo_reports.payload, sends to the SEO agent
 * (moks-seo-agent app/flows/report.py, schema "site-report/1") and renders as HTML, JSON and CSV. Client-safe: no
 * database or server imports, so the report viewer and the forms share it.
 */

export const REPORT_SCHEMA = "site-report/1";

/** How a value is shown. `pct` is a ratio (0.925 → 92.5%); `ms` a duration in milliseconds. */
export type Format = "int" | "float" | "pct" | "usd" | "ms" | "s" | "tokens" | "bytes" | "text";
export type Severity = "critical" | "high" | "medium" | "low";
export const SEVERITIES: readonly Severity[] = ["critical", "high", "medium", "low"];

export type Kpi = { id: string; label: string; value: number | null; format: Format; previous?: number | null; change?: number | null; better?: "up" | "down" | null; note?: string };
export type ChartSeries = { name: string; points: [string, number][] };
export type Chart = { id: string; type: "line" | "bar"; title: string; unit?: string; series: ChartSeries[] };
export type Column = { key: string; label: string; format?: Format; width?: number };
export type Cell = string | number | null;
export type TableBlock = { id: string; title: string; columns: Column[]; rows: Record<string, Cell>[]; note?: string };

/**
 * A problem found in the data by code (never by the AI). `confirmed`: the finding carries its own direct evidence of the
 * cause (a recorded error, a failed check), so the analyst may call a cause that rests on it confirmed; a measured
 * decline is real but says nothing about why.
 */
export type Finding = { id: string; category: string; severity: Severity; title: string; detail: string; impact: string; evidence: string[]; confirmed: boolean; owner?: string | null };

export type SourceState = "ok" | "empty" | "unavailable" | "error" | "not_selected";
export type SourceStatus = { key: string; label: string; category: string; status: SourceState; rows: number | null; detail: string; tables: string[]; ms?: number };
/** A figure the AI analysis may cite, already formatted the way it must be written (checked by the agent). */
export type Fact = { id: string; label: string; value: string };
/** Text recorded by the system (error messages, log lines): evidence for the analyst, never instructions. */
export type Untrusted = { id: string; kind: "error" | "log"; text: string };

export type CategoryBlock = { key: string; label: string; status: "ok" | "partial" | "unavailable"; note: string | null; kpis: Kpi[]; charts: Chart[]; tables: TableBlock[] };

export type ReportRange = { preset: string; label: string; start: string; end: string; previousStart: string; previousEnd: string; days: number; timezone: string };
export type ReportScope = { categories: string[]; crews: string[] | "all"; flows: string[] | "all"; sources: string[] | "all" };

/** What the Report crew wrote, after the agent's check (moks-seo-agent app/crews/report.py check_analysis). */
export type Analysis = {
  executive_summary?: string;
  achievements?: { text: string; evidence: string[] }[];
  risks?: { text: string; evidence: string[] }[];
  root_causes?: { issue: string; cause: string; status: "confirmed" | "probable" | "investigate"; evidence: string[]; next_check?: string; downgraded?: boolean }[];
  fixes?: { issue: string; severity: Severity; evidence: string[]; impact: string; fix: string; steps: string[]; expected_outcome?: string; effort?: string }[];
  recommendations?: { area: string; text: string; evidence: string[] }[];
  action_plan?: { priority: Severity; action: string; owner?: string; evidence: string[] }[];
};
export type AnalysisCheck = { ok?: boolean; checked?: number; kept?: number; removed?: { section: string; reason: string; text: string }[]; downgraded?: number; reason?: string | null };

export type SiteReport = {
  schema: typeof REPORT_SCHEMA;
  id: string;
  title: string;
  generatedAt: string;
  site: { id: string; name: string; origin: string };
  tenant: string;
  range: ReportRange;
  scope: ReportScope;
  summary: { headline: Kpi[] };
  categories: CategoryBlock[];
  findings: Finding[];
  sources: SourceStatus[];
  facts: Fact[];
  untrusted: Untrusted[];
  /** Filled in when the agent's analysis comes back (or why there is none). */
  analysis?: Analysis | null;
  analysisCheck?: AnalysisCheck | null;
  aiUnavailable?: string | null;
};

export const REPORT_STATUSES = ["queued", "running", "completed", "failed", "cancelled"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];
export const FILE_KINDS = ["pdf", "html", "json", "csv"] as const;
export type FileKind = (typeof FILE_KINDS)[number];
export type StoredFile = { key: string; bytes: number; contentType: string; filename: string; storedAt: string };
