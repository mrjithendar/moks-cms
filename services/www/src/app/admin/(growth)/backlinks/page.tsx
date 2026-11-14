import { AdminHeader, Card } from "@/components/admin/ui";
import { ApiButton } from "@/components/seo/ApiButton";
import { Badge } from "@/components/seo/badges";
import { Empty, Section } from "@/components/seo/ui";
import { backlinkOverview, dataForSeoStatus } from "@/lib/seo-intel/dataforseo";
import { getSeoSettings } from "@/lib/seo-intel/settings";

export const metadata = { title: "Backlinks" };

const fmt = (v: unknown) => (typeof v === "number" ? Intl.NumberFormat("en").format(v) : "—");

function Delta({ now, before }: { now: unknown; before: unknown }) {
  if (typeof now !== "number" || typeof before !== "number" || now === before) return null;
  const d = now - before;
  return <span className={`ml-1 text-xs ${d > 0 ? "text-emerald-800 dark:text-emerald-300" : "text-red-800 dark:text-red-300"}`}>{d > 0 ? "+" : ""}{fmt(d)}</span>;
}

function DomainList({ rows, empty }: { rows: { domain: string; rank: number | null; backlinks: number | null }[]; empty: string }) {
  return rows.length ? (
    <ul className="divide-y divide-line text-sm">
      {rows.map((d) => (
        <li key={d.domain} className="flex justify-between gap-3 py-1.5">
          <a href={`https://${d.domain}`} rel="noopener noreferrer nofollow" target="_blank" className="truncate text-fg hover:underline">{d.domain}</a>
          <span className="shrink-0 tabular-nums text-fg-muted">rank {d.rank ?? "—"} · {fmt(d.backlinks)} link{d.backlinks === 1 ? "" : "s"}</span>
        </li>
      ))}
    </ul>
  ) : <Empty>{empty}</Empty>;
}

const CARDS = [["Referring domains", "referring_domains"], ["Backlinks", "backlinks"], ["Domain rank", "rank"], ["Broken backlinks", "broken_backlinks"]] as const;

/** Weekly referring-domain snapshots from DataForSEO's Backlinks API, and what changed since the previous one. */
export default async function BacklinksPage() {
  const s = await getSeoSettings();
  const [o, dfs] = await Promise.all([backlinkOverview(), dataForSeoStatus(s)]);
  const on = dfs.enabled && dfs.credentials && s.dataforseo.backlinks.enabled;
  const sum = o?.summary ?? {};
  const prev = o?.previousSummary ?? {};
  const spam = sum.backlinks_spam_score;
  return (
    <>
      <AdminHeader
        title="Backlinks"
        description="Sites linking to this one, from DataForSEO's link index (weekly snapshot). It is DataForSEO's crawl, not Google's: counts differ from Search Console's Links report."
        actions={on ? <ApiButton url="/api/admin/seo/dataforseo/run" body={{ job: "backlinks" }} label="Take a snapshot now" confirm={`Buy a backlink snapshot (about $0.07)? Spend so far this month: $${dfs.spentUsd.toFixed(2)} of $${dfs.budgetUsd}.`} /> : undefined}
      />
      {!on && (
        <Card className="mb-4 !p-4 text-sm text-fg-muted">
          Backlinks are off. They need DataForSEO credentials (DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD), DataForSEO switched on and <strong>Backlinks</strong> enabled in Settings → Data sources, and an active Backlinks API subscription at DataForSEO.
        </Card>
      )}
      {o ? (
        <>
          <ul className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {CARDS.map(([label, k]) => (
              <li key={k}>
                <Card className="!p-4">
                  <p className="text-xs text-fg-subtle">{label}</p>
                  <p className="text-2xl font-semibold tabular-nums text-fg">
                    {fmt(sum[k])}
                    <Delta now={sum[k]} before={prev[k]} />
                  </p>
                </Card>
              </li>
            ))}
          </ul>
          <p className="mb-4 text-xs text-fg-subtle">
            Snapshot {o.takenAt.slice(0, 16).replace("T", " ")} UTC{o.previousAt ? `, compared with ${o.previousAt.slice(0, 10)}` : " (the first one: gained and lost appear from the next snapshot)"}.
            {typeof spam === "number" && (
              <>
                {" "}Spam score <Badge t={spam >= 30 ? "amber" : "gray"}>{spam}</Badge>
              </>
            )}
          </p>
          <div className="grid gap-4 lg:grid-cols-2">
            <Section title={`Gained (${o.gained.length})`} description="Referring domains in this snapshot that were not in the previous one.">
              <DomainList rows={o.gained} empty="No new referring domains." />
            </Section>
            <Section title={`Lost (${o.lost.length})`} description="In the previous snapshot, gone now. Worth a look when a strong domain drops out.">
              <DomainList rows={o.lost} empty="No referring domains lost." />
            </Section>
          </div>
          <Section title="Strongest referring domains" description="By DataForSEO domain rank (0–1000).">
            <DomainList rows={o.top} empty="No referring domains found." />
          </Section>
        </>
      ) : on ? (
        <Empty>No snapshot yet. The first one runs on the scheduled weekday, or take one now.</Empty>
      ) : null}
    </>
  );
}
