import { sql } from "drizzle-orm";
import Link from "next/link";
import { getDb } from "@/db";
import { rowsOf } from "@/db/rows";
import { AdminHeader, Card, StatusPill } from "@/components/admin/ui";
import { CalendarControls } from "@/components/seo/CalendarControls";
import { CalendarItemFields, type CalendarBrief } from "@/components/seo/CalendarItemFields";
import { NewCalendarItem } from "@/components/seo/NewCalendarItem";
import { Empty, fmtInt, Section } from "@/components/seo/ui";
import { listCalendar, monthRange } from "@/lib/seo-intel/calendar";
import { addDays } from "@/lib/seo-intel/sqlutil";

export const metadata = { title: "Editorial calendar" };

type Item = Awaited<ReturnType<typeof listCalendar>>["all"][number];

function ItemCard({ item, owners, compact = false }: { item: Item; owners: { id: string; name: string }[]; compact?: boolean }) {
  const brief = item.brief as CalendarBrief & { internalLinks?: { title: string; path: string }[]; source?: string };
  const auto = brief.source === "auto_planner";
  return (
    <Card className={compact ? "!p-3" : ""}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <StatusPill status={item.status === "published" ? "published" : item.status === "dropped" ? "rejected" : item.status === "suggested" ? "pending" : "approved"} />
        <span className="text-fg-subtle">{item.status.replace("_", " ")} · {item.kind === "measured" ? "Measured (Search Console)" : "Editorial idea"} · {item.priorityBand}</span>
        {auto && <span className="rounded-full bg-violet-100 px-2 py-0.5 font-semibold text-violet-800 dark:bg-violet-500/15 dark:text-violet-300">Auto-planned</span>}
      </div>
      {/* Why the planner put it here (docs/seo/TOPICS.md "Automatic planning"); the same text is the item's Notes. */}
      {auto && brief.notes ? <p className="mt-1 whitespace-pre-line text-xs text-fg-muted">{brief.notes}</p> : null}
      <CalendarItemFields id={item.id} title={item.title} cluster={item.cluster} category={item.category} ownerId={item.ownerId} owners={owners} brief={brief} compact={compact} />
      {brief.internalLinks?.length ? <p className="mt-1 text-xs text-fg-subtle">Link to: {brief.internalLinks.map((l) => l.title).join("; ")}</p> : null}
      {item.postId && <p className="mt-1 text-sm">Draft: <Link className="underline" href={`/admin/posts/${item.postId}`}>{item.postTitle ?? item.postId}</Link> ({item.postStatus}){item.status === "published" && <> · clicks since publish (GSC): {fmtInt(item.clicksSincePublish)}</>}</p>}
      <CalendarControls id={item.id} status={item.status} targetDate={item.targetDate} targetTime={item.targetTime} postId={item.postId} />
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
  const owners = rowsOf<{ id: string; name: string }>(await (await getDb()).execute(sql`select id, coalesce(nullif(name, ''), email) as name from "user" where role in ('admin', 'author') order by name`));
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
              <ul className="mt-1 space-y-1">{(byDay.get(d) ?? []).map((i) => <li key={i.id} className="rounded bg-accent-soft px-1 py-0.5 text-xs text-accent-text [overflow-wrap:anywhere]" title={i.targetTime ? `${i.targetTime} IST · ${i.title}` : i.title}>{i.targetTime && <span className="font-semibold tabular-nums">{i.targetTime} </span>}{i.title}</li>)}</ul>
            </li>
          ))}
        </ol>
      </Section>
      <Section title="Scheduled items">
        {cal.scheduled.length ? <div className="space-y-3">{cal.scheduled.map((i) => <ItemCard key={i.id} item={i} owners={owners} compact />)}</div> : <Empty>Nothing scheduled in this range.</Empty>}
      </Section>
      <Section title={`Unscheduled (${cal.unscheduled.length})`} description="Suggestions from the recommendation engine (Measured or Editorial idea) and manual items without a date.">
        {cal.unscheduled.length ? <div className="space-y-3">{cal.unscheduled.map((i) => <ItemCard key={i.id} item={i} owners={owners} />)}</div> : <Empty>No unscheduled items.</Empty>}
      </Section>
      <Section title="Add an item"><Card><NewCalendarItem /></Card></Section>
    </>
  );
}
