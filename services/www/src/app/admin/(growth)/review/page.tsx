import Link from "next/link";
import { AdminHeader, Card } from "@/components/admin/ui";
import { ReviewQueue } from "@/components/seo/ReviewQueue";
import { RescanControl, UnreviewedList } from "@/components/seo/ReviewRescan";
import { Empty } from "@/components/seo/ui";
import { buttonClass } from "@/components/ui/form";
import { reviewQueue, type QueueFilter } from "@/lib/seo-intel/drafts";
import { unreviewedArticles } from "@/lib/seo-intel/review-scan";
import { claudeConfig, getSeoSettings } from "@/lib/seo-intel/settings";

export const metadata = { title: "Review queue" };

const TYPES = [["", "All types"], ["paragraph_edit", "Edits"], ["paragraph_add", "Additions"], ["heading", "Headings"], ["internal_link", "Links"], ["external_link", "Docs links"], ["title", "Titles"], ["meta_description", "Meta"], ["alt_text", "Alt text"]] as const;
const STATUSES = [["", "Any status"], ["ready_for_review", "Ready for review"], ["generating", "Being written"], ["generation_failed", "Failed"], ["scheduled", "Scheduled"]] as const;
const KINDS = [["", "Any kind"], ["optimize", "Optimisation of a published article"], ["new_article", "New article"]] as const;
type Tab = "articles" | "news" | "unreviewed" | "done";

export default async function ReviewPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const tab: Tab = sp.tab === "news" || sp.tab === "done" || sp.tab === "unreviewed" ? sp.tab : "articles";
  const q = (sp.q ?? "").trim().slice(0, 100);
  const f: QueueFilter = {
    collection: tab === "news" ? "news" : tab === "articles" ? "blog" : undefined,
    type: sp.type || undefined,
    priority: sp.priority === "high" || sp.priority === "medium" || sp.priority === "low" ? sp.priority : undefined,
    maxAgeDays: sp.age ? Math.min(365, Math.max(1, Number(sp.age) || 0)) : undefined,
    sort: sp.sort === "newest" || sp.sort === "oldest" || sp.sort === "changes" ? sp.sort : "priority",
    done: tab === "done",
  };
  const [queue, articles, news, unreviewed, s] = await Promise.all([
    tab === "unreviewed" ? Promise.resolve([]) : reviewQueue(f),
    reviewQueue({ collection: "blog" }),
    reviewQueue({ collection: "news" }),
    unreviewedArticles({ q: tab === "unreviewed" ? q : undefined }),
    getSeoSettings(),
  ]);
  const items = queue.filter((i) => (!q || i.title.toLowerCase().includes(q.toLowerCase())) && (!sp.status || i.status === sp.status) && (!sp.kind || i.kind === sp.kind));
  const keySet = Boolean(claudeConfig(s).apiKey);
  const link = (patch: Record<string, string>) => `?${new URLSearchParams(Object.entries({ ...sp, ...patch }).filter(([, v]) => v) as [string, string][])}`;
  const input = "min-h-11 rounded-md border border-line-strong bg-surface px-2 text-sm text-fg md:min-h-9";
  const counts: Record<Tab, number | null> = { articles: articles.length, news: news.length, unreviewed: unreviewed.length, done: null };
  const filtered = Boolean(q || sp.type || sp.priority || sp.age || sp.status || sp.kind);
  return (
    <>
      <AdminHeader title="Review queue" description="AI-drafted changes waiting for you. Nothing goes live until you approve an article; approving publishes it and submits it to search engines." />
      {!keySet && <p role="status" className="mb-4 rounded-lg border border-line bg-surface-muted px-4 py-3 text-sm text-fg">Needs credentials: set <code>ANTHROPIC_API_KEY</code> to start drafting (docs/seo/MANUAL_SETUP.md). Existing drafts can still be reviewed.</p>}

      <Card className="mb-6 !p-4">
        <h2 className="mb-2 text-sm font-semibold text-fg">Rescan for re-review</h2>
        <RescanControl waiting={unreviewed.length} />
      </Card>

      <nav aria-label="Queue tabs" className="mb-4 flex flex-wrap gap-1 border-b border-line">
        {([["articles", "Articles"], ["news", "News"], ["unreviewed", "Not reviewed"], ["done", "Published"]] as const).map(([k, label]) => (
          <Link key={k} href={link({ tab: k, type: "", priority: "", age: "", status: "", kind: "", q: "" })} aria-current={tab === k ? "page" : undefined} className={`-mb-px inline-flex min-h-11 items-center gap-2 border-b-2 px-3 text-sm font-medium ${tab === k ? "border-accent text-fg" : "border-transparent text-fg-muted hover:text-fg"}`}>
            {label}
            {counts[k] !== null && <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-xs tabular-nums text-fg-muted">{counts[k]}</span>}
          </Link>
        ))}
      </nav>

      <form method="get" className="mb-4 flex flex-wrap items-end gap-2" aria-label="Filters">
        <input type="hidden" name="tab" value={tab} />
        <label className="grid min-w-48 flex-1 gap-1 text-xs text-fg-subtle">Search<input type="search" name="q" defaultValue={q} placeholder="Article title" className={input} /></label>
        {tab !== "unreviewed" && (
          <>
            {tab !== "done" && <label className="grid gap-1 text-xs text-fg-subtle">Status<select name="status" defaultValue={sp.status ?? ""} className={input}>{STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>}
            {tab === "articles" && <label className="grid gap-1 text-xs text-fg-subtle">Kind<select name="kind" defaultValue={sp.kind ?? ""} className={input}>{KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>}
            <label className="grid gap-1 text-xs text-fg-subtle">Type<select name="type" defaultValue={sp.type ?? ""} className={input}>{TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
            <label className="grid gap-1 text-xs text-fg-subtle">Priority<select name="priority" defaultValue={sp.priority ?? ""} className={input}><option value="">Any</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></label>
            <label className="grid gap-1 text-xs text-fg-subtle">Age<select name="age" defaultValue={sp.age ?? ""} className={input}><option value="">Any</option><option value="7">≤ 7 days</option><option value="30">≤ 30 days</option></select></label>
            <label className="grid gap-1 text-xs text-fg-subtle">Sort<select name="sort" defaultValue={sp.sort ?? "priority"} className={input}><option value="priority">Priority</option><option value="newest">Newest</option><option value="oldest">Oldest</option><option value="changes">Most changes</option></select></label>
          </>
        )}
        <button className={buttonClass("primary", "sm")}>Apply</button>
        {filtered && <Link className={buttonClass("ghost", "sm")} href={link({ type: "", priority: "", age: "", status: "", kind: "", q: "", sort: "" })}>Clear</Link>}
      </form>

      {tab === "unreviewed" ? (
        unreviewed.length ? <UnreviewedList items={unreviewed} /> : <Empty>{q ? "No article matches." : "Every published article has a draft in the queue or was reviewed in the last 90 days."}</Empty>
      ) : items.length ? (
        <ReviewQueue items={items} />
      ) : (
        <Empty>{filtered ? "No draft matches these filters." : tab === "done" ? "No published drafts yet." : "Nothing waiting. Drafts appear here after the weekly run, a rescan, or “Draft optimization” on a recommendation or keyword."}</Empty>
      )}
    </>
  );
}
