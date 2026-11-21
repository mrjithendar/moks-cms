import { sql } from "drizzle-orm";
import Link from "next/link";
import { Card, StatusPill } from "@/components/admin/ui";
import { ApiButton } from "@/components/seo/ApiButton";
import { getDb } from "@/db";
import { rowsOf } from "@/db/rows";
import { failingFlows } from "@/lib/health";
import { agentToken } from "@/lib/seo-agent/config";
import { agentStatus } from "@/lib/seo-agent/endpoint";
import { integrationsView } from "@/lib/seo-intel/queries";
import { claudeConfig, getSeoSettings } from "@/lib/seo-intel/settings";

/**
 * Settings → "Connections": one line per integration with its state, read from configuration and the last recorded
 * results (seo_integrations, sync history, seo_flow_runs). Nothing here calls an external service while rendering,
 * except the SEO agent's status (its cached /healthz check); "Test Google connection" runs the live check on demand. No secret value is ever shown, only whether it is set.
 */
export type ConnectionRow = { key: string; name: string; status: "ok" | "degraded" | "down" | "not configured" | "configured"; detail: string; href?: string };

const sourcePill = (state: string): ConnectionRow["status"] => (state === "ok" ? "ok" : state === "disconnected" ? "not configured" : state === "stale" || state === "never_synced" ? "degraded" : "down");

export async function loadConnections(env: Record<string, string | undefined> = process.env): Promise<ConnectionRow[]> {
  const [iv, s] = await Promise.all([integrationsView(), getSeoSettings()]);
  const rows: ConnectionRow[] = [];
  for (const p of ["gsc", "ga4"] as const) {
    const st = iv.status[p];
    rows.push({ key: p, name: p === "gsc" ? "Search Console" : "Google Analytics 4", status: sourcePill(st.state), detail: st.message, href: "/admin/integrations" });
  }
  const ps = { enabled: iv.pageSpeed.enabled, keyConfigured: Boolean(env.PAGESPEED_API_KEY?.trim()) };
  rows.push({
    key: "pagespeed",
    name: "PageSpeed Insights / CrUX",
    status: ps.enabled && ps.keyConfigured ? "ok" : ps.enabled ? "degraded" : ps.keyConfigured ? "configured" : "not configured",
    detail: ps.enabled ? (ps.keyConfigured ? "On; API key set (PAGESPEED_API_KEY)." : "On, but PAGESPEED_API_KEY is not set: field data quota is very low.") : ps.keyConfigured ? "API key set; turn it on under Data sources → Google properties → Page speed." : "Off.",
  });
  rows.push({
    key: "url_inspection",
    name: "URL Inspection API",
    status: iv.urlInspection.enabled ? (iv.credentials.configured ? "ok" : "degraded") : "not configured",
    detail: iv.urlInspection.enabled ? `On, up to ${iv.urlInspection.dailyLimit} URLs a day (needs Full permission on the property).` : "Off.",
  });
  const cfg = claudeConfig(s, env);
  rows.push({
    key: "claude",
    name: "Claude (drafting)",
    status: cfg.apiKey ? "ok" : "not configured",
    detail: cfg.apiKey ? "Key set (ANTHROPIC_API_KEY). The limit is the LLM budget (Settings → LLM budget)." : "ANTHROPIC_API_KEY is not set: drafting and intent labelling use rules only.",
  });
  // The only line that may probe the network: the agent's status (cached per process; endpoint.ts).
  const st = await agentStatus(env === process.env ? {} : { env });
  let agent: ConnectionRow = { key: "agent", name: "SEO agent (CrewAI flows)", status: "not configured", detail: `${st.reason} The web worker runs every job.`, href: "#seo-agent" };
  if (st.enabled) {
    let last: { flow_name: string; status: string; finished_at: string | null } | undefined;
    let failing: { flow: string; at: string; error: string }[] = [];
    try {
      const db = await getDb();
      [last] = rowsOf<{ flow_name: string; status: string; finished_at: string | null }>(await db.execute(sql`select flow_name, status, finished_at::text from seo_flow_runs where finished_at is not null order by finished_at desc limit 1`));
      // Degraded only while a flow's latest run in the last day failed (one old failure does not mark it for ever).
      failing = await failingFlows();
    } catch {
      last = undefined; // migration 0016 not applied yet
    }
    const tokenOk = Boolean(agentToken(env));
    agent = {
      key: "agent",
      name: "SEO agent (CrewAI flows)",
      href: "#seo-agent",
      status: !tokenOk ? "down" : !last ? "degraded" : failing.length ? "degraded" : "ok",
      detail: !tokenOk
        ? st.reason
        : failing.length
          ? `Latest run failed in the last 24 h: ${failing.map((f) => `${f.flow} at ${f.at} UTC (${f.error})`).join("; ")}.`
          : last
            ? `Last finished run: ${last.flow_name} (${last.status}) at ${last.finished_at?.slice(0, 16).replace("T", " ")} UTC; no flow's latest run failed in the last 24 h.`
            : "No finished flow run recorded yet.",
    };
  }
  rows.push(agent);
  return rows;
}

export function IntegrationStatusCard({ rows }: { rows: ConnectionRow[] }) {
  const problems = rows.filter((r) => r.status === "down" || r.status === "degraded").length;
  return (
    <Card className="mb-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold text-fg">Connections</h2>
        <div className="flex items-center gap-3">
          <span className="text-sm text-fg-muted">{problems ? `${problems} need${problems === 1 ? "s" : ""} attention` : "Nothing needs attention"}</span>
          <ApiButton url="/api/admin/seo/integrations/test" label="Test Google connection" />
        </div>
      </div>
      <ul className="mt-3 divide-y divide-line">
        {rows.map((r) => (
          <li key={r.key} className="grid gap-1 py-2 text-sm sm:grid-cols-[14rem_7rem_1fr] sm:items-baseline sm:gap-3">
            <span className="font-medium text-fg">{r.href ? <Link href={r.href} className="hover:underline">{r.name}</Link> : r.name}</span>
            <span>
              <StatusPill status={r.status} />
            </span>
            <span className="text-fg-muted [overflow-wrap:anywhere]">{r.detail}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
