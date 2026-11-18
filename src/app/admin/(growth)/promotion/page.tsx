import Link from "next/link";
import { AdminHeader, Card } from "@/components/admin/ui";
import { ApiButton } from "@/components/seo/ApiButton";
import { Badge, type Tone } from "@/components/seo/badges";
import { CopyText } from "@/components/seo/CopyText";
import { PromoDraftEditor } from "@/components/seo/PromoDraftEditor";
import { PromotionSettingsForm } from "@/components/seo/PromotionSettingsForm";
import { Empty, fmtInt, fmtWhen, Section } from "@/components/seo/ui";
import { orchestrator } from "@/lib/seo-agent/config";
import { CHANNELS } from "@/lib/seo-intel/promotion/channels";
import { redditState } from "@/lib/seo-intel/promotion/reddit";
import { CHANNEL_IDS, getPromotionSettings } from "@/lib/seo-intel/promotion/settings";
import { listIdeas, listOpportunities, promotionCounts, type Idea, type Opportunity, type PromotedArticle } from "@/lib/seo-intel/promotion/store";
import { promotionPlan, type Strategy } from "@/lib/seo-intel/promotion/strategies";

export const metadata = { title: "Promotion" };

const TABS = [
  ["strategies", "Strategies"],
  ["drafts", "Posts to review"],
  ["opportunities", "Opportunities"],
  ["posted", "Posted"],
  ["ideas", "Content ideas"],
  ["settings", "Settings"],
] as const;
type Tab = (typeof TABS)[number][0];

const BAND: Record<Opportunity["band"], Tone> = { high: "green", medium: "blue", low: "gray" };
const STATUS: Record<Opportunity["status"], [Tone, string]> = { open: ["gray", "No draft yet"], drafted: ["violet", "Draft to review"], posted: ["green", "Posted"], dismissed: ["gray", "Dismissed"] };

function OpportunityCard({ o }: { o: Opportunity }) {
  const [tone, label] = STATUS[o.status];
  return (
    <li className="rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-fg">{o.label}</span>
        <Badge t={BAND[o.band]} title="Score from the article, Search Console clicks and matching Reddit threads. It orders channels; it is not a forecast.">Score {fmtInt(o.score)} · {o.band}</Badge>
        <Badge t={tone}>{label}</Badge>
        {o.editedBy && o.status === "drafted" && <span className="text-xs text-fg-subtle">edited by {o.editedBy}</span>}
      </div>
      {o.reasons.length > 0 && <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-fg-muted">{o.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
      {o.threads.length > 0 && (
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer text-fg-muted">Related Reddit threads ({o.threads.length})</summary>
          <ul className="mt-1 space-y-1 pl-5">
            {o.threads.map((t) => (
              <li key={t.url} className="[overflow-wrap:anywhere]">
                <a className="underline" href={t.url} target="_blank" rel="noopener noreferrer">r/{t.community}: {t.title}</a> <span className="text-xs text-fg-subtle">({fmtInt(t.score)} upvotes, {fmtInt(t.comments)} comments)</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {o.status === "posted" && <p className="mt-2 text-sm text-fg-muted">Posted {fmtWhen(o.postedAt)}{o.postedUrl && <> · <a className="underline [overflow-wrap:anywhere]" href={o.postedUrl} target="_blank" rel="noopener noreferrer">{o.postedUrl}</a></>}</p>}
      {o.flags.length > 0 && o.status === "drafted" && <ul className="mt-2 space-y-0.5 text-xs text-amber-800 dark:text-amber-300">{o.flags.map((f) => <li key={f}>Check: {f}</li>)}</ul>}
      {o.draftNotes && o.status === "drafted" && <p className="mt-2 text-xs text-fg-subtle">Note from the draft: {o.draftNotes}</p>}
      {o.status === "open" ? (
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer text-fg-muted">Write it yourself</summary>
          <p className="mt-1 text-xs text-fg-subtle">{o.guidance}</p>
          <PromoDraftEditor id={o.id} label={o.label} hasTitle={o.hasTitle} title={o.draftTitle} body={o.draftBody} maxChars={o.maxChars} link={o.link} postUrl={o.postUrl} status={o.status} />
        </details>
      ) : (
        <>
          {o.status === "drafted" && <p className="mt-2 text-xs text-fg-subtle">{o.guidance}</p>}
          <PromoDraftEditor id={o.id} label={o.label} hasTitle={o.hasTitle} title={o.draftTitle} body={o.draftBody} maxChars={o.maxChars} link={o.link} postUrl={o.postUrl} status={o.status} />
        </>
      )}
    </li>
  );
}

/** One strategy: what it is, how to do it, and the articles it applies to now, with the action that carries it out. */
function StrategyCard({ s, canRun }: { s: Strategy; canRun: boolean }) {
  const action = (i: Strategy["items"][number]) => {
    switch (s.id) {
      case "evergreen":
        return <ApiButton url="/api/admin/seo/promotion/reshare" body={{ articleId: i.articleId }} label="Reshare" confirm={canRun ? "Reopen this article's channels and draft fresh posts with Claude? Nothing is posted." : "Reopen this article's channels so you can write fresh posts? Nothing is posted."} />;
      case "refresh":
        return <ApiButton url="/api/admin/seo/drafts" body={{ articleId: i.articleId, mode: "regenerate", extra: [{ id: "refresh-freshness", category: "freshness", problem: "Search clicks are falling: check that commands, versions, links and facts are current, and fix what is outdated." }, { id: "refresh-title-meta", category: "title_meta", problem: "Search clicks are falling: make the title and meta description match what searchers look for now." }] }} label="Refresh first" confirm="Send this article for an AI review (a model cost)? The draft waits in the review queue." />;
      case "launch":
        return canRun ? <ApiButton url="/api/admin/seo/promotion/run" body={{ kind: "opportunities", articleId: i.articleId }} label="Draft posts" confirm="Score channels for this article and draft posts with Claude?" /> : <Link className="link text-sm" href="?tab=drafts">Posts to review</Link>;
      case "syndicate":
        return <Link className="link text-sm" href="?tab=opportunities">dev.to / Hashnode drafts</Link>;
      case "community":
        return i.url ? <a className="link text-sm" href={i.url} target="_blank" rel="noopener noreferrer">Open thread ↗</a> : null;
      case "internal":
        return <Link className="link text-sm" href="/admin/links">Internal linking</Link>;
      default:
        return null;
    }
  };
  return (
    <Card>
      <h3 className="text-base font-semibold text-fg">{s.title}</h3>
      <p className="mt-1 text-sm text-fg-muted">{s.summary}</p>
      <p className="mt-1 text-xs text-fg-subtle">How: {s.how}</p>
      {s.digest ? (
        <div className="mt-3"><CopyText text={s.digest} label="Copy the issue" /></div>
      ) : s.items.length ? (
        <ul className="mt-3 divide-y divide-line rounded-lg border border-line">
          {s.items.map((i, n) => (
            <li key={`${i.articleId}-${n}`} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <div className="min-w-0">
                <Link className="text-sm font-medium text-fg hover:underline [overflow-wrap:anywhere]" href={i.path} target="_blank">{i.title}</Link>
                <p className="text-xs text-fg-subtle [overflow-wrap:anywhere]">{i.why}</p>
              </div>
              {action(i)}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-fg-subtle">Nothing to do here right now.</p>
      )}
    </Card>
  );
}

function ArticleCard({ a, canRun }: { a: PromotedArticle; canRun: boolean }) {
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-fg [overflow-wrap:anywhere]"><Link className="underline" href={a.path}>{a.title}</Link></h3>
          <p className="text-xs text-fg-subtle">Published {fmtWhen(a.publishedAt)} · <Link className="underline" href={`/admin/posts/${a.articleId}`}>Open in editor</Link></p>
        </div>
        {canRun && <ApiButton url="/api/admin/seo/promotion/run" body={{ kind: "opportunities", articleId: a.articleId }} label="Re-score and draft posts" confirm="Re-score this article's channels and draft posts with Claude? Drafts you edited, posted or dismissed are kept." />}
      </div>
      <ul className="mt-3 space-y-3">{a.opportunities.map((o) => <OpportunityCard key={o.id} o={o} />)}</ul>
    </Card>
  );
}

function IdeaCard({ idea }: { idea: Idea }) {
  const url = `/api/admin/seo/promotion/ideas/${idea.id}`;
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2">
        <Badge t={BAND[idea.band]} title="From verified evidence only: Search Console impressions and Reddit threads. It orders ideas; it is not a forecast.">Score {fmtInt(idea.score)} · {idea.band}</Badge>
        <Badge t="gray">{idea.source === "mixed" ? "Search Console + Reddit" : idea.source === "reddit" ? "Reddit" : "Search Console"}</Badge>
        {idea.status === "saved" && <Badge t="blue">Saved</Badge>}
        {idea.status === "sent" && <Badge t="green">On the calendar</Badge>}
        {idea.status === "dismissed" && <Badge t="gray">Dismissed</Badge>}
      </div>
      <h3 className="mt-2 text-base font-semibold text-fg [overflow-wrap:anywhere]">{idea.title}</h3>
      {idea.angle && <p className="mt-1 text-sm text-fg-muted">{idea.angle}</p>}
      {idea.targetQuery && <p className="mt-1 text-xs text-fg-subtle">Target query: {idea.targetQuery}</p>}
      {idea.outline.length > 0 && <ol className="mt-2 list-decimal space-y-0.5 pl-5 text-sm text-fg-muted">{idea.outline.map((h) => <li key={h}>{h}</li>)}</ol>}
      <p className="mt-3 text-xs font-semibold text-fg-subtle">Why (evidence)</p>
      <ul className="mt-1 space-y-1 text-sm text-fg-muted">
        {idea.signals.map((s) => (
          <li key={`${s.type}:${s.label}`} className="[overflow-wrap:anywhere]">
            {s.type === "reddit" ? (
              <>{s.url ? <a className="underline" href={s.url} target="_blank" rel="noopener noreferrer">{s.label}</a> : s.label} <span className="text-xs text-fg-subtle">({fmtInt(s.score ?? 0)} upvotes, {fmtInt(s.comments ?? 0)} comments)</span></>
            ) : (
              <>Search Console {s.type === "gsc_topic" ? "topic" : "query"} “{s.label}” <span className="text-xs text-fg-subtle">({fmtInt(s.impressions ?? 0)} impressions in 28 days{s.position !== null && s.position !== undefined ? `, position ${s.position}` : ""})</span></>
            )}
          </li>
        ))}
      </ul>
      {idea.channels.length > 0 && <p className="mt-2 flex flex-wrap items-center gap-1 text-xs text-fg-subtle">Would promote on: {idea.channels.map((c) => <Badge key={c.id}>{c.label}</Badge>)}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {idea.status === "sent" ? (
          <Link className="text-sm underline" href="/admin/calendar">On the editorial calendar</Link>
        ) : (
          <>
            <ApiButton url={url} method="PATCH" body={{ action: "calendar" }} label="Add to editorial calendar" variant="primary" />
            {idea.status === "new" && <ApiButton url={url} method="PATCH" body={{ action: "save" }} label="Save for later" />}
            {idea.status === "dismissed" ? <ApiButton url={url} method="PATCH" body={{ action: "restore" }} label="Restore" /> : <ApiButton url={url} method="PATCH" body={{ action: "dismiss" }} label="Dismiss" />}
          </>
        )}
      </div>
    </Card>
  );
}

export default async function PromotionPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const tab: Tab = TABS.some(([t]) => t === sp.tab) ? (sp.tab as Tab) : "strategies";
  const ideaStatus = sp.show === "dismissed" || sp.show === "sent" ? sp.show : undefined;
  const [settings, counts, reddit] = await Promise.all([getPromotionSettings(), promotionCounts(), redditState()]);
  const crewai = orchestrator() === "crewai";
  const canRun = settings.enabled && crewai;
  const articles = tab === "drafts" ? await listOpportunities({ status: "drafted" }) : tab === "opportunities" ? await listOpportunities({ status: sp.status === "dismissed" ? "dismissed" : "open" }) : tab === "posted" ? await listOpportunities({ status: "posted" }) : [];
  const ideas = tab === "ideas" ? await listIdeas({ status: ideaStatus }) : [];
  const plan = tab === "strategies" ? await promotionPlan() : [];
  const count: Record<Tab, number | null> = { strategies: null, drafts: counts.drafted, opportunities: counts.open, posted: counts.posted, ideas: counts.ideas, settings: null };
  return (
    <>
      <AdminHeader
        title="Promotion"
        description="Where each published article is worth sharing, with posts drafted for you to edit and post yourself, and ideas for new articles that already have an audience. Nothing is posted automatically."
        actions={canRun ? (
          <>
            <ApiButton url="/api/admin/seo/promotion/run" body={{ kind: "opportunities" }} label="Find opportunities" confirm="Score channels for the newest articles without opportunities and draft posts with Claude?" />
            <ApiButton url="/api/admin/seo/promotion/run" body={{ kind: "ideas" }} label="Suggest content ideas" confirm="Collect Search Console and Reddit signals and ask Claude for content ideas?" />
          </>
        ) : undefined}
      />
      {!settings.enabled && <p className="mb-4 rounded-lg border border-line bg-surface-muted px-4 py-3 text-sm text-fg-muted">Promotion is switched off. Turn it on under <Link className="underline" href="?tab=settings">Settings</Link>.</p>}
      {settings.enabled && !crewai && <p className="mb-4 rounded-lg border border-line bg-surface-muted px-4 py-3 text-sm text-fg-muted">Promotion runs as CrewAI flows in the SEO agent. Set <code>SEO_ORCHESTRATOR=crewai</code> to start runs from here.</p>}
      {settings.enabled && !reddit.configured && tab !== "settings" && <p className="mb-4 rounded-lg border border-line bg-surface-muted px-4 py-3 text-sm text-fg-muted">Reddit is not connected yet, so threads are not used as a signal. See <Link className="underline" href="?tab=settings">Settings</Link>.</p>}
      <nav aria-label="Promotion views" className="mb-6 flex flex-wrap gap-x-4 gap-y-2 text-sm">
        {TABS.map(([t, label]) => (
          <Link key={t} href={`?tab=${t}`} aria-current={tab === t ? "page" : undefined} className={tab === t ? "font-semibold text-fg" : "underline text-fg-muted"}>
            {label}{count[t] !== null ? ` (${fmtInt(count[t])})` : ""}
          </Link>
        ))}
      </nav>

      {tab === "strategies" && (
        <Section title="Strategies" description="Seven ways an article earns readers, each with the articles it applies to right now. Every action ends in drafts or links for you to review; nothing is posted automatically.">
          <div className="grid gap-4 lg:grid-cols-2">{plan.map((s) => <StrategyCard key={s.id} s={s} canRun={canRun} />)}</div>
        </Section>
      )}

      {tab === "drafts" && (
        <Section title="Posts to review" description="Drafted by Claude from the article, in each channel's style. Edit, copy, post it yourself, then mark it as posted.">
          {articles.length ? <div className="space-y-4">{articles.map((a) => <ArticleCard key={a.articleId} a={a} canRun={canRun} />)}</div> : <Empty>No drafts waiting. Use “Find opportunities”, or wait for the daily run after you publish an article.</Empty>}
        </Section>
      )}

      {tab === "opportunities" && (
        <Section
          title={sp.status === "dismissed" ? "Dismissed opportunities" : "Opportunities without a draft"}
          description={<>Channels that scored below the drafting threshold ({settings.minScore}) or have not been drafted yet. {sp.status === "dismissed" ? <Link className="underline" href="?tab=opportunities">Show open</Link> : <Link className="underline" href="?tab=opportunities&status=dismissed">Show dismissed ({fmtInt(counts.dismissed)})</Link>}</>}
        >
          {articles.length ? <div className="space-y-4">{articles.map((a) => <ArticleCard key={a.articleId} a={a} canRun={canRun} />)}</div> : <Empty>Nothing here.</Empty>}
        </Section>
      )}

      {tab === "posted" && (
        <Section title="Posted" description="Posts you recorded as posted. Visits from them carry the tagged link's utm_source in your analytics.">
          {articles.length ? <div className="space-y-4">{articles.map((a) => <ArticleCard key={a.articleId} a={a} canRun={false} />)}</div> : <Empty>Nothing recorded as posted yet.</Empty>}
        </Section>
      )}

      {tab === "ideas" && (
        <Section
          title="Content ideas"
          description={<>Articles worth writing because people are searching for or discussing the subject and the site has no article on it. Every idea lists the evidence it rests on. Show: <Link className="underline" href="?tab=ideas">open</Link> · <Link className="underline" href="?tab=ideas&show=sent">on the calendar</Link> · <Link className="underline" href="?tab=ideas&show=dismissed">dismissed</Link></>}
        >
          {ideas.length ? <div className="space-y-4">{ideas.map((i) => <IdeaCard key={i.id} idea={i} />)}</div> : <Empty>No ideas here. Use “Suggest content ideas”, or wait for the weekly run.</Empty>}
        </Section>
      )}

      {tab === "settings" && (
        <>
          <Section title="Reddit (read-only)" description="Used to find threads about your subjects. The site only reads public listings; it never posts, votes or messages.">
            <Card>
              <p className="text-sm text-fg">{reddit.configured ? "Configured." : "Requires manual configuration."} <span className="text-fg-muted">{fmtInt(reddit.threads)} thread{reddit.threads === 1 ? "" : "s"} stored · last read {fmtWhen(reddit.lastFetched)}</span></p>
              {!reddit.configured && (
                <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-fg-muted">
                  <li>Create an app of type “script” at reddit.com/prefs/apps (Reddit may ask you to accept its API terms first).</li>
                  <li>Put its client id and secret in the Secret <code>jithendar-com-env</code> as <code>REDDIT_CLIENT_ID</code> and <code>REDDIT_CLIENT_SECRET</code> (<code>scripts/set-reddit-config.sh</code>), then restart the site.</li>
                  <li>Come back here and test the connection.</li>
                </ol>
              )}
              <div className="mt-3"><ApiButton url="/api/admin/seo/promotion/reddit/test" label="Test connection" /></div>
            </Card>
          </Section>
          <Section title="Promotion settings">
            <Card><PromotionSettingsForm settings={settings} channels={CHANNEL_IDS.map((id) => ({ id, label: CHANNELS[id].label }))} /></Card>
          </Section>
        </>
      )}
    </>
  );
}
