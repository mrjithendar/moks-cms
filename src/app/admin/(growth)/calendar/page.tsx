import { sql } from "drizzle-orm";
import Link from "next/link";
import { getDb } from "@/db";
import { rowsOf } from "@/db/rows";
import { AdminHeader, Card } from "@/components/admin/ui";
import { CalendarActions } from "@/components/seo/CalendarActions";
import { CalendarItemCard, DRAFT_LABEL } from "@/components/seo/CalendarItemCard";
import { CalendarItemFields, type CalendarBrief } from "@/components/seo/CalendarItemFields";
import { NewCalendarItem } from "@/components/seo/NewCalendarItem";
import { Empty, fmtInt, Section } from "@/components/seo/ui";
import { buttonClass } from "@/components/ui/form";
import { istToday, listCalendar, monthRange, PHASES, weekStartOf, type CalendarItem } from "@/lib/seo-intel/calendar";
import { addDays } from "@/lib/seo-intel/sqlutil";

export const metadata = { title: "Editorial calendar" };

const SOURCE_LABEL: Record<CalendarItem["source"], string> = { measured: "Search Console", ml: "ML query clusters", analytics: "Google Analytics", ai: "AI (reader questions, Promotion)", editorial: "Editorial idea", manual: "Added by hand" };
const SORTS = { date: "Date", priority: "Priority", title: "Title", newest: "Newest" } as const;
type Sort = keyof typeof SORTS;
const CHIP: Record<string, string> = {
  unscheduled: "bg-surface-sunken text-fg-muted",
  scheduled: "bg-sky-100 text-sky-900 dark:bg-sky-500/15 dark:text-sky-200",
  published: "bg-emerald-100 text-emerald-900 dark:bg-emerald-500/15 dark:text-emerald-200",
};

/** "past": dated items whose date has passed while their post is not scheduled (System status links here). */
const DUE = { past: "Past their date" } as const;
type Filters = { phase: string; source: string; category: string; cluster: string; draft: string; due: string; q: string; sort: Sort };

function readFilters(sp: Record<string, string | undefined>): Filters {
  const pick = (v: string | undefined, allowed: readonly string[]) => (v && allowed.includes(v) ? v : "");
  return {
    phase: pick(sp.phase, PHASES),
    source: pick(sp.source, Object.keys(SOURCE_LABEL)),
    category: (sp.category ?? "").slice(0, 60),
    cluster: (sp.cluster ?? "").slice(0, 200),
    draft: pick(sp.draft, Object.keys(DRAFT_LABEL)),
    due: pick(sp.due, Object.keys(DUE)),
    q: (sp.q ?? "").trim().slice(0, 100),
    sort: (pick(sp.sort, Object.keys(SORTS)) || "date") as Sort,
  };
}

function applyFilters(items: CalendarItem[], f: Filters, withPhase = true) {
  const q = f.q.toLowerCase();
  return items.filter(
    (i) =>
      (!withPhase || !f.phase || i.phase === f.phase) &&
      (!f.source || i.source === f.source) &&
      (!f.category || i.category === f.category) &&
      (!f.cluster || i.cluster === f.cluster) &&
      (!f.draft || i.draft === f.draft) &&
      (!f.due || i.overdue) &&
      (!q || `${i.title} ${i.cluster ?? ""} ${i.category ?? ""}`.toLowerCase().includes(q)),
  );
}

function sortItems(items: CalendarItem[], sort: Sort) {
  const by: Record<Sort, (a: CalendarItem, b: CalendarItem) => number> = {
    date: (a, b) => (a.targetDate ?? "9999").localeCompare(b.targetDate ?? "9999") || (a.targetTime ?? "").localeCompare(b.targetTime ?? "") || b.priorityScore - a.priorityScore,
    priority: (a, b) => b.priorityScore - a.priorityScore,
    title: (a, b) => a.title.localeCompare(b.title),
    newest: (a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
  };
  return [...items].sort(by[sort]);
}

/** Why a dated item's post is not scheduled yet (the stored note, or what its draft state means). */
function pendingNote(i: CalendarItem): string | null {
  if (i.phase !== "scheduled" || i.draft === "scheduled") return null;
  // A stored note explains a ready draft that could not be scheduled (fact-check errors, fields the post needs);
  // for every other state the draft's current state says more than a note written when it was different.
  if (i.draft === "ready" && i.scheduleNote) return i.overdue ? `Its date (${i.targetDate}) has passed. ${i.scheduleNote}` : i.scheduleNote;
  const why: Record<string, string> = {
    none: "Planned for this date, but there is no draft yet. Generate it, review it, then press Schedule.",
    outline: "Planned for this date, but the draft is only an outline. Generate it, review it, then press Schedule.",
    writing: "Planned for this date. The draft is being written: review it when it is ready, then press Schedule.",
    failed: "Planned for this date, but the draft failed. Generate it again, review it, then press Schedule.",
    ready: "Planned for this date. The draft is ready: review it, then press Schedule to publish it then.",
  };
  const note = why[i.draft] ?? null;
  // A passed date is the first thing to fix: pick a new date (Schedule), or delete the idea.
  return note && i.overdue ? `Its date (${i.targetDate}) has passed: choose a new date below, or delete the item. ${note}` : note;
}

const ist = (iso: string) => `${new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })} IST`;
const when = (i: CalendarItem) => (i.targetDate ? `${i.targetDate}${i.targetTime ? ` ${i.targetTime}` : ""} IST${i.overdue ? " · date passed" : ""}` : i.publishedAt ? `published ${i.publishedAt.slice(0, 10)}` : null);

function ItemCard({ item, owners, open }: { item: CalendarItem; owners: { id: string; name: string }[]; open: boolean }) {
  const brief = item.brief as CalendarBrief & { internalLinks?: { title: string; path: string }[] };
  const meta = [SOURCE_LABEL[item.source], `${item.priorityBand} priority`, item.category].filter(Boolean).join(" · ");
  return (
    <CalendarItemCard title={item.title} phase={item.phase} draft={item.draft} meta={meta} when={when(item)} defaultOpen={open}>
      <CalendarItemFields id={item.id} title={item.title} cluster={item.cluster} category={item.category} ownerId={item.ownerId} owners={owners} brief={brief} />
      {brief.internalLinks?.length ? <p className="mt-3 text-sm text-fg-muted">Link to: {brief.internalLinks.map((l) => l.title).join("; ")}</p> : null}
      {item.postId && (
        <p className="mt-3 text-sm text-fg-muted">
          Post: <Link className="link" href={`/admin/posts/${item.postId}`}>{item.postTitle ?? item.postId}</Link> ({item.postStatus}){item.postScheduledFor && <> · publishes {ist(item.postScheduledFor)}</>}
          {item.phase === "published" && <> · clicks since publish (Search Console): {fmtInt(item.clicksSincePublish)}</>}
        </p>
      )}
      {pendingNote(item) && <p className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">{pendingNote(item)}</p>}
      {item.draft === "failed" && item.agentFailure && <p className="mt-2 text-sm text-red-700 dark:text-red-300">Last attempt failed: {item.agentFailure}</p>}
      {(item.flagErrors > 0 || item.flagWarnings > 0) && item.draft !== "published" && (
        <p className="mt-2 text-sm text-fg-muted">Fact-check notes from the SEO agent: {item.flagErrors} error(s), {item.flagWarnings} warning(s), shown in the post editor.</p>
      )}
      <CalendarActions item={{ id: item.id, draft: item.draft, postId: item.postId, postPath: item.postPath, targetDate: item.targetDate, targetTime: item.targetTime }} />
    </CalendarItemCard>
  );
}

export default async function CalendarPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const f = readFilters(sp);
  const view = sp.view === "week" ? "week" : "month";
  const { from, to, month } = monthRange(sp.month);
  // This week in the editorial time zone (until 2026-11-24 it was the UTC week: wrong from 00:00 to 05:30 IST on Mondays).
  const weekStart = sp.week && /^\d{4}-\d{2}-\d{2}$/.test(sp.week) ? weekStartOf(sp.week) : weekStartOf(istToday());
  const range = view === "week" ? { from: weekStart, to: addDays(weekStart, 6) } : { from, to };
  const cal = await listCalendar(range);
  const owners = rowsOf<{ id: string; name: string }>(await (await getDb()).execute(sql`select id, coalesce(nullif(name, ''), email) as name from "user" where role in ('admin', 'author') order by name`));

  const matching = applyFilters(cal.all, f, false);
  const counts = { all: matching.length, ...Object.fromEntries(PHASES.map((p) => [p, matching.filter((i) => i.phase === p).length])) } as Record<string, number>;
  const shown = sortItems(applyFilters(cal.all, f), f.sort);
  const categories = [...new Set(cal.all.map((i) => i.category).filter((c): c is string => !!c))].sort();
  const clusters = [...new Set(cal.all.map((i) => i.cluster).filter((c): c is string => !!c))].sort();

  const days: string[] = [];
  for (let d = range.from; d <= range.to; d = addDays(d, 1)) days.push(d);
  const lead = view === "month" ? (new Date(`${range.from}T00:00:00Z`).getUTCDay() + 6) % 7 : 0;
  const prevMonth = monthRange(addDays(from, -1).slice(0, 7)).month;
  const nextMonth = monthRange(addDays(to, 1).slice(0, 7)).month;
  const byDay = new Map<string, CalendarItem[]>();
  for (const i of applyFilters(cal.scheduled, f)) byDay.set(i.targetDate!, [...(byDay.get(i.targetDate!) ?? []), i]);

  // Links keep the other filters and the calendar view.
  const keep = (over: Record<string, string>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ view, ...(sp.month ? { month: sp.month } : {}), ...(sp.week ? { week: sp.week } : {}), ...f, ...over })) if (v && !(k === "sort" && v === "date")) q.set(k, v);
    return `?${q.toString()}`;
  };
  const filtered = !!(f.source || f.category || f.cluster || f.draft || f.due || f.q);
  const pastDue = cal.all.filter((i) => i.overdue).length;
  const select = "min-h-9 rounded-md border border-line-strong bg-surface px-2 text-sm text-fg";

  return (
    <>
      <AdminHeader
        title="Editorial calendar"
        description="Ideas move from unscheduled to scheduled to published. Generate a draft, improve it until you are happy, then schedule it: the post publishes by itself at that date and time."
      />

      <nav aria-label="Phase" className="mb-4 flex flex-wrap gap-1 border-b border-line">
        {(["", ...PHASES] as const).map((p) => (
          <Link key={p || "all"} href={keep({ phase: p })} aria-current={f.phase === p ? "page" : undefined} className={`-mb-px inline-flex min-h-11 items-center gap-2 border-b-2 px-3 text-sm font-medium capitalize ${f.phase === p ? "border-accent text-fg" : "border-transparent text-fg-muted hover:text-fg"}`}>
            {p || "All"} <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-xs tabular-nums text-fg-muted">{counts[p || "all"]}</span>
          </Link>
        ))}
      </nav>

      {pastDue > 0 && !f.due && (
        <p role="status" className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
          {pastDue} item(s) are past their date and not scheduled. <Link className="font-medium underline" href={keep({ due: "past", phase: "" })}>Show them</Link> to choose a new date, finish the draft or delete the idea.
        </p>
      )}

      <Card className="mb-6 !p-4">
        <form method="get" className="flex flex-wrap items-end gap-3" aria-label="Filter the calendar">
          <input type="hidden" name="view" value={view} />
          {sp.month && <input type="hidden" name="month" value={sp.month} />}
          {sp.week && <input type="hidden" name="week" value={sp.week} />}
          {f.phase && <input type="hidden" name="phase" value={f.phase} />}
          <label className="grid min-w-48 flex-1 gap-1 text-xs font-medium text-fg-muted">
            Search
            <input type="search" name="q" defaultValue={f.q} placeholder="Title, cluster or category" className={select} />
          </label>
          <label className="grid gap-1 text-xs font-medium text-fg-muted">
            Source
            <select name="source" defaultValue={f.source} className={select}>
              <option value="">Any source</option>
              {Object.entries(SOURCE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-xs font-medium text-fg-muted">
            Draft
            <select name="draft" defaultValue={f.draft} className={select}>
              <option value="">Any draft state</option>
              {Object.entries(DRAFT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-xs font-medium text-fg-muted">
            Date
            <select name="due" defaultValue={f.due} className={select}>
              <option value="">Any date</option>
              {Object.entries(DUE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-xs font-medium text-fg-muted">
            Category
            <select name="category" defaultValue={f.category} className={select}>
              <option value="">Any category</option>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          {clusters.length > 0 && (
            <label className="grid gap-1 text-xs font-medium text-fg-muted">
              Cluster
              <select name="cluster" defaultValue={f.cluster} className={`${select} max-w-48`}>
                <option value="">Any cluster</option>
                {clusters.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
          )}
          <label className="grid gap-1 text-xs font-medium text-fg-muted">
            Sort
            <select name="sort" defaultValue={f.sort} className={select}>
              {Object.entries(SORTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <button type="submit" className={buttonClass("primary", "sm")}>Apply</button>
          {(filtered || f.sort !== "date") && <Link className={buttonClass("ghost", "sm")} href={keep({ source: "", category: "", cluster: "", draft: "", due: "", q: "", sort: "date" })}>Clear</Link>}
        </form>
      </Card>

      <Section title={view === "month" ? `Calendar · ${month}` : `Calendar · ${range.from} – ${range.to}`}>
        <nav aria-label="Calendar view" className="mb-3 flex flex-wrap items-center gap-3 text-sm">
          <Link href={keep({ view: "month" })} aria-current={view === "month" ? "true" : undefined} className={view === "month" ? "font-semibold" : "link"}>Month</Link>
          <Link href={keep({ view: "week" })} aria-current={view === "week" ? "true" : undefined} className={view === "week" ? "font-semibold" : "link"}>Week</Link>
          <span className="text-fg-subtle" aria-hidden="true">|</span>
          {view === "month" ? (
            <><Link className="link" href={keep({ month: prevMonth })}>← {prevMonth}</Link><span className="font-semibold">{month}</span><Link className="link" href={keep({ month: nextMonth })}>{nextMonth} →</Link></>
          ) : (
            <><Link className="link" href={keep({ week: addDays(weekStart, -7) })}>← previous</Link><span className="font-semibold">{range.from} – {range.to}</span><Link className="link" href={keep({ week: addDays(weekStart, 7) })}>next →</Link></>
          )}
          <span className="ml-auto flex flex-wrap items-center gap-2 text-xs text-fg-subtle">
            {(["scheduled", "published"] as const).map((p) => <span key={p} className={`rounded px-1.5 py-0.5 capitalize ${CHIP[p]}`}>{p}</span>)}
          </span>
        </nav>
        <div className="hidden grid-cols-7 gap-1 text-xs font-semibold text-fg-subtle sm:grid">{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d} className="px-1">{d}</div>)}</div>
        <ol className="grid gap-1 sm:grid-cols-7">
          {Array.from({ length: lead }, (_, i) => <li key={`lead-${i}`} className="hidden sm:block" aria-hidden="true" />)}
          {days.map((d) => (
            <li key={d} className={`min-h-20 rounded-md border p-1 ${byDay.has(d) ? "border-line-strong bg-surface" : "border-line bg-surface-muted"} ${byDay.has(d) ? "" : "hidden sm:block"}`}>
              <p className="text-xs text-fg-subtle">{d.slice(8)}<span className="sm:hidden"> {d}</span></p>
              <ul className="mt-1 space-y-1">
                {(byDay.get(d) ?? []).map((i) => (
                  <li key={i.id} className={`rounded px-1 py-0.5 text-xs [overflow-wrap:anywhere] ${CHIP[i.phase]}`} title={`${i.targetTime ? `${i.targetTime} IST · ` : ""}${i.title} · ${DRAFT_LABEL[i.draft]}`}>
                    {i.targetTime && <span className="font-semibold tabular-nums">{i.targetTime} </span>}
                    {i.title}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      </Section>

      <Section title={`${f.phase ? f.phase[0]!.toUpperCase() + f.phase.slice(1) : "All"} items (${shown.length})`} description="Expand an item to edit its brief, generate or improve its draft and schedule it.">
        {shown.length ? (
          <div className="space-y-3">{shown.map((i) => <ItemCard key={i.id} item={i} owners={owners} open={shown.length === 1} />)}</div>
        ) : (
          <Empty>{filtered || f.phase ? "No item matches these filters." : "The calendar is empty. Add an idea below."}</Empty>
        )}
      </Section>

      <Section title="Add an item"><Card><NewCalendarItem /></Card></Section>
    </>
  );
}
