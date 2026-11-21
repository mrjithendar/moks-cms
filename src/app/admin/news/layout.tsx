import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { NewsNav } from "@/components/news/NewsNav";
import { ensureNewsDefaults } from "@/lib/news/service";
import { newsDeskState, newsDeskStateText } from "@/lib/news/schema";
import { getNewsSettings } from "@/lib/news/service";
import { newsAgentStatus } from "@/lib/news-agent/endpoint";
import { requireRole } from "@/lib/session";

export const metadata: Metadata = { title: { default: "News desk", template: "%s · News desk · Admin" }, robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/**
 * /admin/news/* is admin-only. A banner on every page says so while the news desk is off, and where to switch it on;
 * and while the news agent (the service that runs the desk) is not found, where to set it up.
 */
export default async function NewsLayout({ children }: { children: ReactNode }) {
  await requireRole("admin");
  await ensureNewsDefaults().catch(() => undefined);
  const state = newsDeskState(await getNewsSettings().catch(() => null));
  const on = state.on;
  const agent = await newsAgentStatus().catch(() => null);
  return (
    <div>
      <NewsNav />
      {!on && (
        <p role="status" className="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
          {newsDeskStateText(state)} You can configure jobs, sources and profiles; nothing runs until it is on.{" "}
          <Link className="underline" href="/admin/news/settings">Newsroom settings</Link>
        </p>
      )}
      {on && agent && !agent.enabled && (
        <p role="status" className="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
          The news desk is on, but nothing runs: {agent.reason}{" "}
          <Link className="underline" href="/admin/news/settings#news-agent">News agent</Link>
        </p>
      )}
      {children}
    </div>
  );
}
