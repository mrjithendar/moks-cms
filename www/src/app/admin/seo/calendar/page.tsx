import Link from "next/link";
import { AdminHeader, Card, StatusPill } from "@/components/admin/ui";
import { CalendarControls } from "@/components/seo/CalendarControls";
import { NewCalendarItem } from "@/components/seo/NewCalendarItem";
import { Empty, fmtInt, Section } from "@/components/seo/ui";
import { listCalendar, monthRange } from "@/lib/seo-intel/calendar";
import { addDays } from "@/lib/seo-intel/sqlutil";

export const metadata = { title: "Editorial calendar" };

type Item = Awaited<ReturnType<typeof listCalendar>>["all"][number];

function ItemCard({ item, compact = false }: { item: Item; compact?: boolean }) {
  const brief = item.brief as { audience?: string; intent?: string; supportingQueries?: string[]; gap?: string; outline?: string[]; codeExamples?: string[]; diagrams?: string[]; internalLinks?: { title: string; path: string }[]; readingTimeMinutes?: number; notes?: string };
  return (
    <Card className={compact ? "!p-3" : ""}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <StatusPill status={item.status === "published" ? "published" : item.status === "dropped" ? "rejected" : item.status === "suggested" ? "pending" : "approved"} />
        <span className="text-fg-subtle">{item.status.replace("_", " ")} · {item.kind === "measured" ? "Measured (Search Console)" : "Editorial idea"} · {item.priorityBand}</span>
      </div>
      <p className="mt-1 font-semibold text-fg [overflow-wrap:anywhere]">{item.title}</p>
      <p className="text-xs text-fg-subtle">{[item.cluster, item.category, item.targetDate && `target ${item.targetDate}`, item.ownerName && `owner ${item.ownerName}`].filter(Boolean).join(" · ")}</p>
      {item.postId && <p className="mt-1 text-sm">Draft: <Link className="underline" href={`/admin/posts/${item.postId}`}>{item.postTitle ?? item.postId}</Link> ({item.postStatus}){item.status === "published" && <> · clicks since publish (GSC): {fmtInt(item.clicksSincePublish)}</>}</p>}
      {!compact && (
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer text-fg-muted">Brief</summary>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            {brief.gap && <><dt className="text-fg-subtle">Gap</dt><dd>{brief.gap}</dd></>}
            {brief.audience && <><dt className="text-fg-subtle">Audience</dt><dd>{brief.audience}</dd></>}
            {brief.intent && <><dt className="text-fg-subtle">Intent</dt><dd>{brief.intent}</dd></>}
            {brief.supportingQueries?.length ? <><dt className="text-fg-subtle">Queries</dt><dd>{brief.supportingQueries.join(", ")}</dd></> : null}
            {brief.outline?.length ? <><dt className="text-fg-subtle">Outline</dt><dd><ol className="list-decimal pl-5">{brief.outline.map((o) => <li key={o}>{o}</li>)}</ol></dd></> : null}
            {brief.codeExamples?.length ? <><dt className="text-fg-subtle">Code</dt><dd>{brief.codeExamples.join("; ")}</dd></> : null}
            {brief.diagrams?.length ? <><dt className="text-fg-subtle">Diagrams</dt><dd>{brief.diagrams.join("; ")}</dd></> : null}
            {brief.internalLinks?.length ? <><dt className="text-fg-subtle">Link to</dt><dd>{brief.internalLinks.map((l) => l.title).join("; ")}</dd></> : null}
            {brief.readingTimeMinutes ? <><dt className="text-fg-subtle">Reading time</dt><dd>~{brief.readingTimeMinutes} min</dd></> : null}
            {brief.notes ? <><dt className="text-fg-subtle">Notes</dt><dd>{brief.notes}</dd></> : null}
          </dl>
        </details>
      )}
      <CalendarControls id={item.id} status={item.status} targetDate={item.targetDate} postId={item.postId} />
    </Card>
  );
}

export default async function CalendarPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const view = sp.view === "week" ? "week" : "month";
  const { from, to, month } = monthRange(sp.month);
  const weekStart = sp.week && /^\d{4}-\d{2}-\d{2}$/.test(sp.week) ? sp.week : (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); })();
  const range = view === "week" ? { from: weekStart, to: addDays(weekStart, 6) } : { from, to };
  const cal = await listCalendar(range);
  const days: string[] = [];
  for (let d = range.from; d <= range.to; d = addDays(d, 1)) days.push(d);
  const lead = view === "month" ? (new Date(`${range.from}T00:00:00Z`).getUTCDay() + 6) % 7 : 0;
  const prevMonth = monthRange(addDays(from, -1).slice(0, 7)).month;
  const nextMonth = monthRange(addDays(to, 1).slice(0, 7)).month;
  const byDay = new Map<string, Item[]>();
  for (const i of cal.scheduled) byDay.set(i.targetDate!, [...(byDay.get(i.targetDate!) ?? []), i]);
  return (
    <>
      <AdminHeader title="Editorial calendar" description="Suggested → approved → drafting → in review → published. Items become published only when their linked post is published with the editor's own Publish button." />
      <nav aria-label="Calendar view" className="mb-4 flex flex-wrap items-center gap-3 text-sm">
        <Link href="?view=month" aria-current={view === "month" ? "true" : undefined} className={view === "month" ? "font-semibold" : "underline"}>Month</Link>
        <Link href="?view=week" aria-current={view === "week" ? "true" : undefined} className={view === "week" ? "font-semibold" : "underline"}>Week</Link>
        <span className="text-fg-subtle">|</span>
        {view === "month" ? <><Link className="underline" href={`?view=month&month=${prevMonth}`}>← {prevMonth}</Link><span className="font-semibold">{month}</span><Link className="underline" href={`?view=month&month=${nextMonth}`}>{nextMonth} →</Link></>
          : <><Link className="underline" href={`?view=week&week=${addDays(weekStart, -7)}`}>← previous</Link><span className="font-semibold">{range.from} – {range.to}</span><Link className="underline" href={`?view=week&week=${addDays(weekStart, 7)}`}>next →</Link></>}
      </nav>
      <Section title={view === "month" ? `Scheduled in ${month}` : "Scheduled this week"}>
        <div className="hidden grid-cols-7 gap-1 text-xs font-semibold text-fg-subtle sm:grid">{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d} className="px-1">{d}</div>)}</div>
        <ol className="grid gap-1 sm:grid-cols-7">
          {Array.from({ length: lead }, (_, i) => <li key={`lead-${i}`} className="hidden sm:block" aria-hidden="true" />)}
          {days.map((d) => (
            <li key={d} className={`min-h-20 rounded-md border border-line p-1 ${byDay.has(d) ? "bg-surface" : "bg-surface-muted"} ${byDay.has(d) ? "" : "hidden sm:block"}`}>
              <p className="text-xs text-fg-subtle">{d.slice(8)}<span className="sm:hidden"> {d}</span></p>
              <ul className="mt-1 space-y-1">{(byDay.get(d) ?? []).map((i) => <li key={i.id} className="rounded bg-accent-soft px-1 py-0.5 text-xs text-accent-text [overflow-wrap:anywhere]" title={i.title}>{i.title}</li>)}</ul>
            </li>
          ))}
        </ol>
      </Section>
      <Section title="Scheduled items">
        {cal.scheduled.length ? <div className="space-y-3">{cal.scheduled.map((i) => <ItemCard key={i.id} item={i} compact />)}</div> : <Empty>Nothing scheduled in this range.</Empty>}
      </Section>
      <Section title={`Unscheduled (${cal.unscheduled.length})`} description="Suggestions from the recommendation engine (Measured or Editorial idea) and manual items without a date.">
        {cal.unscheduled.length ? <div className="space-y-3">{cal.unscheduled.map((i) => <ItemCard key={i.id} item={i} />)}</div> : <Empty>No unscheduled items.</Empty>}
      </Section>
      <Section title="Add an item"><Card><NewCalendarItem /></Card></Section>
    </>
  );
}
