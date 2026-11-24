import Link from "next/link";
import type { ReactNode } from "react";
import { AdminHeader, Card } from "@/components/admin/ui";
import { buttonClass } from "@/components/ui/form";
import { moduleState, type ModuleId } from "@/lib/modules";

/**
 * The pages of an optional module (lib/modules.ts): when the module is not set up, they say so and where to set it up,
 * instead of rendering empty or broken; their own components are not loaded. Its menu is hidden at the same time
 * (app/admin/layout.tsx).
 */
export async function ModuleGate({ module, children }: { module: ModuleId; children: ReactNode }) {
  const m = await moduleState(module);
  if (m.installed) return <>{children}</>;
  return (
    <>
      <AdminHeader title={`${m.label} is not set up`} description="This page belongs to an optional module of the admin." />
      <Card>
        <div className="space-y-3 text-sm text-fg-muted">
          <p>{m.reason}</p>
          <p>AI &amp; SEO (its crews, flows, runs and settings) appears in the menu once the {m.label.toLowerCase()} is set up. Everything else in the admin works without it.</p>
          <Link href={m.setupHref} className={buttonClass("primary", "sm")}>Set up the {m.label.toLowerCase()}</Link>
        </div>
      </Card>
    </>
  );
}

/** The layout of a folder of SEO agent pages. */
export function SeoModuleLayout({ children }: { children: ReactNode }) {
  return <ModuleGate module="seo-agent">{children}</ModuleGate>;
}
