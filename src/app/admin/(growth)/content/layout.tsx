import type { ReactNode } from "react";
import { ModuleGate } from "@/components/admin/ModuleGate";
import { ContentNav } from "@/components/news/ContentNav";
import { ensureNewsDefaults } from "@/lib/news/service";

export const dynamic = "force-dynamic";

/**
 * /admin/content/*: content sources, topics, profiles & playground and content analytics, shared by every crew job
 * (they were the Newsroom's until 2026-11-21). Admin-only through the (growth) layout.
 */
export default async function ContentLayout({ children }: { children: ReactNode }) {
  await ensureNewsDefaults().catch(() => undefined);
  return (
    <ModuleGate module="seo-agent">
      <div>
        <ContentNav />
        {children}
      </div>
    </ModuleGate>
  );
}
