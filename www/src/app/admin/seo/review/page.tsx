import Link from "next/link";
import { AdminHeader } from "@/components/admin/ui";
import { ReviewQueue } from "@/components/seo/ReviewQueue";
import { Empty } from "@/components/seo/ui";
import { reviewQueue, type QueueFilter } from "@/lib/seo-intel/drafts";
import { claudeConfig, getSeoSettings } from "@/lib/seo-intel/settings";

export const metadata = { title: "Review queue" };

const TYPES = [["", "All types"], ["paragraph_edit", "Edits"], ["paragraph_add", "Additions"], ["heading", "Headings"], ["internal_link", "Links"], ["title", "Titles"], ["meta_description", "Meta"], ["alt_text", "Alt text"]] as const;

export default async function ReviewPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const tab = sp.tab === "news" ? "news" : sp.tab === "done" ? "done" : "articles";
  const f: QueueFilter = {
    collection: tab === "news" ? "news" : tab === "articles" ? "blog" : undefined,
    type: sp.type || undefined,
    priority: sp.priority === "high" || sp.priority === "medium" || sp.priority === "low" ? sp.priority : undefined,
    maxAgeDays: sp.age ? Math.min(365, Math.max(1, Number(sp.age) || 0)) : undefined,
    sort: sp.sort === "newest" || sp.sort === "oldest" || sp.sort === "changes" ? sp.sort : "priority",
    done: tab === "done",
  };
  const [items, s] = await Promise.all([reviewQueue(f), getSeoSettings()]);
  const keySet = Boolean(claudeConfig(s).apiKey);
  const link = (patch: Record<string, string>) => `?${new URLSearchParams(Object.entries({ ...sp, ...patch }).filter(([, v]) => v) as [string, string][])}`;
  const input = "min-h-11 rounded-md border border-line-strong bg-surface px-2 text-sm text-fg md:min-h-9";
  return (
    <>
      <AdminHeader title="Review queue" description="Claude-drafted changes waiting for you. Nothing goes live until you approve an article; approving publishes it and submits it to search engines." />
      {!keySet && <p role="status" className="mb-4 rounded-lg border border-line bg-surface-muted px-4 py-3 text-sm text-fg">Needs credentials: set <code>ANTHROPIC_API_KEY</code> to start drafting (docs/seo/MANUAL_SETUP.md). Existing drafts can still be reviewed.</p>}
      <nav aria-label="Queue tabs" className="mb-4 flex gap-1 border-b border-line">
        {([["articles", "Articles"], ["news", "News"], ["done", "Published"]] as const).map(([k, label]) => (
          <Link key={k} href={link({ tab: k })} aria-current={tab === k ? "page" : undefined} className={`-mb-px min-h-11 border-b-2 px-3 pt-3 text-sm font-medium ${tab === k ? "border-accent text-fg" : "border-transparent text-fg-muted hover:text-fg"}`}>{label}</Link>
        ))}
      </nav>
      <form method="get" className="mb-4 flex flex-wrap items-end gap-2" aria-label="Filters">
        <input type="hidden" name="tab" value={tab} />
        <label className="grid gap-1 text-xs text-fg-subtle">Type<select name="type" defaultValue={sp.type ?? ""} className={input}>{TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <label className="grid gap-1 text-xs text-fg-subtle">Priority<select name="priority" defaultValue={sp.priority ?? ""} className={input}><option value="">Any</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></label>
        <label className="grid gap-1 text-xs text-fg-subtle">Age<select name="age" defaultValue={sp.age ?? ""} className={input}><option value="">Any</option><option value="7">≤ 7 days</option><option value="30">≤ 30 days</option></select></label>
        <label className="grid gap-1 text-xs text-fg-subtle">Sort<select name="sort" defaultValue={sp.sort ?? "priority"} className={input}><option value="priority">Priority</option><option value="newest">Newest</option><option value="oldest">Oldest</option><option value="changes">Most changes</option></select></label>
        <button className="min-h-11 rounded-md border border-line-strong px-3 text-sm md:min-h-9">Apply</button>
      </form>
      {items.length ? <ReviewQueue items={items} /> : <Empty>{tab === "done" ? "No published drafts yet." : "Nothing waiting. Drafts appear here after the weekly run, or when you use “Draft optimization” on a recommendation or keyword."}</Empty>}
    </>
  );
}
