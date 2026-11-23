"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert } from "@/components/ui/form";
import { api } from "./api";

export type DeskView = { on: boolean; by: "deployment_off" | "admin" | "deployment_legacy" | "default"; text: string };

/**
 * The content flows' switch on AI & SEO → Flows (setting row `news`.enabled; "News desk on" in the Newsroom until
 * 2026-11-21, "Jobs on" until 2026-11-23). Off: no content flow runs (Run now and dry runs are skipped too:
 * moks-seo-agent app/flows/news.py); the flows, sources and profiles stay as they are. NEWS_DESK_ENABLED=false in the
 * deployment forces it off. Other flows (built-in, built from crews) are not affected.
 */
export function JobsSwitch({ desk }: { desk: DeskView }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const forced = desk.by === "deployment_off";
  return (
    <section id="content-switch" aria-labelledby="content-switch-title" className={`mb-6 scroll-mt-24 rounded-xl border p-4 text-sm ${desk.on ? "border-line bg-surface" : "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100"}`}>
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="content-switch-title" className="font-semibold">{desk.on ? "Content flows run on their schedules" : "All content flows are paused"}</h2>
        <label className="ml-auto inline-flex min-h-11 items-center gap-2 font-medium">
          <input
            type="checkbox"
            disabled={forced || busy}
            checked={desk.on}
            onChange={async (e) => {
              setBusy(true);
              setErr(null);
              try {
                await api("/api/admin/news/settings", "PUT", { enabled: e.target.checked, paused: false });
                router.refresh();
              } catch (x) {
                setErr((x as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          />
          Content flows on
        </label>
      </div>
      <p className="mt-1" role="status">{desk.text} Off: no content flow runs, not even Run now or a dry run; the flows, sources and profiles stay as they are. Other flows are not affected.</p>
      {err && <div className="mt-2"><Alert>{err}</Alert></div>}
    </section>
  );
}
