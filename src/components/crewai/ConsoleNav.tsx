"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * The console is about crews and flows: their configuration, runs and logs. Skills, content sources and the AI & SEO
 * settings have their own places in the AI & SEO menu (the "Skills ↗ / Content ↗ / Settings ↗" links were removed here,
 * 2026-11-24, D-100); run-history settings are under Settings → SEO agent → Run history.
 */
const TABS = [
  { href: "/admin/crewai", label: "Overview" },
  { href: "/admin/crewai/flows", label: "Flows" },
  { href: "/admin/crewai/runs", label: "Runs" },
  { href: "/admin/crewai/crews", label: "Crews" },
  { href: "/admin/crewai/reports", label: "Reports" },
  { href: "/admin/crewai/categories", label: "Categories" },
  { href: "/admin/crewai/config", label: "Configuration" },
];

export type AgentPill = { enabled: boolean; version: string | null; reason: string };

/** Section tabs for /admin/crewai, and whether the SEO agent answers (horizontally scrollable on phones). */
export function ConsoleNav({ agent }: { agent: AgentPill }) {
  const path = usePathname();
  // Flows and crews only since 2026-11-23 (no Jobs tab): Schedules belongs to Flows.
  const active = (href: string) => (href === "/admin/crewai" ? path === href : href === "/admin/crewai/flows" && path.startsWith("/admin/crewai/schedules") ? true : path.startsWith(href.split("?")[0]!));
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
