"use client";

import { Card } from "@/components/admin/ui";
import type { HealthInput } from "@/lib/seo-intel/overview-v2";
import { Popover } from "./Popover";

/** The site's SEO health score with an explained breakdown (each input, its score and weight). */
export function HealthScore({ score, inputs }: { score: number | null; inputs: HealthInput[] }) {
  const tone = score === null ? "text-fg-subtle" : score >= 80 ? "text-emerald-700 dark:text-emerald-300" : score >= 60 ? "text-amber-700 dark:text-amber-300" : "text-red-700 dark:text-red-300";
  const measured = inputs.filter((i) => i.score !== null);
  const total = measured.reduce((s, i) => s + i.weight, 0);
  return (
    <Card className="!p-5">
      <p className="text-sm text-fg-subtle">SEO health</p>
      <div className="mt-1 flex items-baseline gap-2">
        <span className={`text-4xl font-semibold tabular-nums ${tone}`}>
          {score === null ? "—" : (
            <Popover label={`SEO health ${score} of 100: how it is calculated`} trigger={<span>{score}</span>}>
              {() => (
                <div>
                  <p className="font-semibold text-fg">How the score is calculated</p>
                  <p className="mt-1 text-xs text-fg-muted">Weighted average of the measured inputs (each 0–100). Inputs not measured yet are left out and the weights renormalised.</p>
                  <table className="mt-2 w-full text-xs">
                    <thead><tr className="text-left text-fg-subtle"><th className="font-medium">Input</th><th className="text-right font-medium">Score</th><th className="text-right font-medium">Weight</th></tr></thead>
                    <tbody>{inputs.map((i) => <tr key={i.key} className="border-t border-line align-top"><td className="py-1 pr-2">{i.label}<span className="block text-fg-subtle">{i.detail}</span></td><td className="py-1 text-right tabular-nums">{i.score ?? "n/a"}</td><td className="py-1 text-right tabular-nums">{i.score === null ? "—" : `${Math.round((i.weight / total) * 100)}%`}</td></tr>)}</tbody>
                  </table>
                </div>
              )}
            </Popover>
          )}
        </span>
        <span className="text-sm text-fg-subtle">/ 100</span>
      </div>
      <ul className="mt-3 space-y-1.5">
        {inputs.map((i) => (
          <li key={i.key} className="text-xs">
            <div className="flex justify-between gap-2"><span className="text-fg-muted">{i.label.split(" (")[0]}</span><span className="tabular-nums text-fg">{i.score ?? "n/a"}</span></div>
            <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-surface-sunken" aria-hidden="true"><div className="h-full bg-accent" style={{ width: `${i.score ?? 0}%` }} /></div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
