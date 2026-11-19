"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/admin/crewai", label: "Overview" },
  { href: "/admin/crewai/runs", label: "Runs" },
  { href: "/admin/crewai/flows", label: "Flows" },
  { href: "/admin/crewai/schedules", label: "Schedules" },
  { href: "/admin/crewai/crews", label: "Crews" },
  { href: "/admin/crewai/config", label: "Import / export" },
  { href: "/admin/automation/skills", label: "Skills ↗" },
  { href: "/admin/automation#tab-runs", label: "Settings ↗" },
];

export type AgentPill = { enabled: boolean; version: string | null; reason: string };

/** Section tabs for /admin/crewai, and whether the SEO agent answers (horizontally scrollable on phones). */
export function ConsoleNav({ agent }: { agent: AgentPill }) {
  const path = usePathname();
  const active = (href: string) => (href === "/admin/crewai" ? path === href : path.startsWith(href.split("?")[0]!));
  return (
    <div className="-mx-4 mb-6 flex items-end gap-4 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:px-0">
      <nav aria-label="CrewAI console" className="min-w-max">
        <ul className="flex gap-1">
          {TABS.map((t) => (
            <li key={t.href}>
              <Link href={t.href} aria-current={active(t.href) ? "page" : undefined} className={`inline-flex min-h-11 items-center border-b-2 px-3 text-sm font-medium ${active(t.href) ? "border-accent text-fg" : "border-transparent text-fg-muted hover:text-fg"}`}>
                {t.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <p className="ml-auto mb-2 inline-flex shrink-0 items-center gap-2 text-xs text-fg-muted" title={agent.reason}>
        <span className={`h-2 w-2 rounded-full ${agent.enabled ? "bg-emerald-500" : "bg-amber-500"}`} aria-hidden="true" />
        <span className={agent.enabled ? "sr-only sm:not-sr-only" : ""}>{agent.enabled ? `Agent online${agent.version ? ` · ${agent.version.slice(0, 12)}` : ""}` : "Agent off"}</span>
      </p>
    </div>
  );
}
