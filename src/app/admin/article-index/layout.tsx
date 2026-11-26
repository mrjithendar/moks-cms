import type { ReactNode } from "react";
import { SeoModuleLayout } from "@/components/admin/ModuleGate";

/** The article index browser: shown only while the SEO agent module is set up (lib/modules.ts). */
export default function Layout({ children }: { children: ReactNode }) {
  return <SeoModuleLayout>{children}</SeoModuleLayout>;
}
