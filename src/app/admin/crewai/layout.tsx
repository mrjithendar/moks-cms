import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { ConsoleNav } from "@/components/crewai/ConsoleNav";
import { hasRunHistory } from "@/lib/crewai/runs";
import { agentStatus } from "@/lib/seo-agent/endpoint";
import { requireRole } from "@/lib/session";

export const metadata: Metadata = { title: { default: "CrewAI console", template: "%s · CrewAI console · Admin" }, robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/**
 * /admin/crewai/*: the SEO agent's flows, runs and logs (admins; a demo account reads only, authors are sent away).
 * History is read from the database, so it shows even while the agent is off; starting or cancelling a run needs it.
 */
export default async function CrewaiLayout({ children }: { children: ReactNode }) {
  await requireRole("admin");
  const [agent, history] = await Promise.all([agentStatus().catch(() => ({ enabled: false, version: null, reason: "Status unavailable." })), hasRunHistory().catch(() => false)]);
  return (
    <div>
      <ConsoleNav agent={{ enabled: agent.enabled, version: agent.version, reason: agent.reason }} />
      {!agent.enabled && (
        <p role="status" className="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
          The SEO agent is off ({agent.reason}). Run history stays readable; re-running and cancelling need the agent. Set it up under{" "}
          <Link className="font-medium underline" href="/admin/automation?section=overview">AI &amp; SEO → Settings → Overview</Link>.
        </p>
      )}
      {!history && (
        <p role="status" className="mb-6 rounded-lg border border-line bg-surface-muted p-3 text-sm text-fg-muted">
          Step lists, logs and transcripts appear once database migration 0036 is applied (the web app applies it when it starts) and the agent has its grants (<code>scripts/db-role.sql</code> in moks-seo-agent, when it uses its own role). Runs are listed meanwhile.
        </p>
      )}
      {children}
    </div>
  );
}
