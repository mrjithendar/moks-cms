import Link from "next/link";
import { Flash, type FlashParams } from "@/components/admin/Flash";
import { AdminHeader, Card } from "@/components/admin/ui";
import { Button, Field, Input, Select, Textarea } from "@/components/ui/form";
import { getDb } from "@/db";
import { adminActor } from "@/lib/admin";
import { audit } from "@/lib/audit";
import { flash } from "@/lib/flash";
import { PostError } from "@/lib/posts";
import { AgentError, kickoff } from "@/lib/seo-agent/client";
import { orchestrator } from "@/lib/seo-agent/config";
import { AutomationSettingsError, EDITORIAL_TZ, getAutomationSettings, MODE_LABELS, MODES, PERIODS, saveAutomationSettings, type AutomationSettings } from "@/lib/seo-intel/topics/automation";
import { dismissTopic, listTopics, topicToCalendar, type StoredTopic } from "@/lib/seo-intel/topics/discover";
import { getTopicsSettings, saveTopicsSettings, SOURCE_IDS, SOURCE_LABELS, TopicsSettingsError, type TopicsSettings } from "@/lib/seo-intel/topics/settings";

export const metadata = { title: "Topic discovery" };

const BACK = "/admin/topics";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const num = (form: FormData, name: string, fallback: number) => {
  const n = Number(String(form.get(name) ?? "").trim());
  return Number.isFinite(n) ? n : fallback;
};

async function saveSettings(form: FormData) {
  "use server";
  const actor = await adminActor();
  await flash(`${BACK}#settings`, async () => {
    const cur = await getTopicsSettings();
    const on = (name: string) => form.get(name) === "true";
    const next: TopicsSettings = {
      enabled: on("enabled"),
      sources: { searchConsole: on("source.searchConsole"), hackernews: on("source.hackernews"), devto: on("source.devto"), github: on("source.github"), reddit: on("source.reddit"), x: on("source.x") },
      dataForSeo: { enabled: on("dataForSeo.enabled"), locationCode: num(form, "dataForSeo.locationCode", cur.dataForSeo.locationCode), languageCode: String(form.get("dataForSeo.languageCode") ?? cur.dataForSeo.languageCode).trim().toLowerCase() },
      terms: String(form.get("terms") ?? "").split(/[\n,]/).map((t) => t.trim().toLowerCase()).filter(Boolean),
      weights: { demand: num(form, "weight.demand", cur.weights.demand), trend: num(form, "weight.trend", cur.weights.trend), fit: num(form, "weight.fit", cur.weights.fit), ease: num(form, "weight.ease", cur.weights.ease) },
      minScore: num(form, "minScore", cur.minScore),
      minImpressions: num(form, "minImpressions", cur.minImpressions),
      hnMinPoints: num(form, "hnMinPoints", cur.hnMinPoints),
      maxCandidates: num(form, "maxCandidates", cur.maxCandidates),
    };
    try {
      await saveTopicsSettings(next, actor.id);
    } catch (e) {
      if (e instanceof TopicsSettingsError) throw new PostError(e.message, 400, e.issues);
      throw e;
    }
    await audit(actor, "topics.settings", undefined, { enabled: next.enabled, sources: next.sources, dataForSeo: next.dataForSeo.enabled });
    return "Topic discovery settings saved.";
  });
}

async function saveAutomation(form: FormData) {
  "use server";
  const actor = await adminActor();
  await flash(`${BACK}#automation`, async () => {
    const cur = await getAutomationSettings();
    const next = {
      mode: String(form.get("mode") ?? cur.mode),
      cadence: { count: num(form, "cadence.count", cur.cadence.count), period: String(form.get("cadence.period") ?? cur.cadence.period) },
      days: form.getAll("days").map((d) => Number(d)).filter((d) => Number.isInteger(d)),
      time: String(form.get("time") ?? cur.time).trim(),
      horizonDays: num(form, "horizonDays", cur.horizonDays),
      minScore: num(form, "autoMinScore", cur.minScore),
    };
    try {
      const { after } = await saveAutomationSettings(next, actor.id);
      await audit(actor, "topics.automation", undefined, { mode: after.mode, cadence: after.cadence });
    } catch (e) {
      if (e instanceof AutomationSettingsError) throw new PostError(e.message, 400, e.issues);
      throw e;
    }
    return "Automatic planning settings saved.";
  });
}

async function planNow() {
  "use server";
  const actor = await adminActor();
  await flash(`${BACK}#automation`, async () => {
    if ((await getAutomationSettings()).mode === "off") throw new PostError("Automatic planning is off. Choose a mode and save first.", 409);
    if (orchestrator() !== "crewai") throw new PostError("Planning runs as a CrewAI flow: set SEO_ORCHESTRATOR=crewai.", 409);
    try {
      const r = await kickoff("calendar_plan_flow", {}, { actor: actor.label });
      await audit(actor, "topics.plan", undefined, { runId: r.run_id });
    } catch (e) {
      if (e instanceof AgentError) throw new PostError(e.message, 503);
      throw e;
    }
    return "Planning started. Open the editorial calendar in a minute to see what was added.";
  });
}

async function runNow() {
  "use server";
  const actor = await adminActor();
  await flash(BACK, async () => {
    if (orchestrator() !== "crewai") throw new PostError("Topic discovery runs as a CrewAI flow: set SEO_ORCHESTRATOR=crewai.", 409);
    try {
      const r = await kickoff("topic_discovery_flow", {}, { actor: actor.label });
      await audit(actor, "topics.run", undefined, { runId: r.run_id });
    } catch (e) {
      if (e instanceof AgentError) throw new PostError(e.message, 503);
      throw e;
    }
    return "Discovery started. Reload in a minute to see the new list.";
  });
}

async function act(form: FormData) {
  "use server";
  const actor = await adminActor();
  const id = String(form.get("id") ?? "");
  const what = String(form.get("what") ?? "");
  await flash(BACK, async () => {
    if (!UUID.test(id)) throw new PostError("Unknown topic.", 404);
    const db = await getDb();
    if (what === "dismiss") {
      if (!(await dismissTopic(db, id))) throw new PostError("That topic is no longer in the list.", 409);
      await audit(actor, "topics.dismiss", id);
      return "Topic dismissed.";
    }
    const r = await topicToCalendar(db, id, { status: "approved" });
    if (!r) throw new PostError("That topic is already in the calendar or no longer in the list.", 409);
    await audit(actor, "topics.calendar", id, { calendarId: r.calendarId });
    return "Added to the editorial calendar (approved, no date yet).";
  });
}

const KIND: Record<StoredTopic["kind"], string> = { keyword: "Search demand", trend: "Trending", both: "Search demand + trending" };

function TopicCard({ t }: { t: StoredTopic }) {
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-semibold text-fg">{t.title}</h3>
          <p className="mt-0.5 text-xs text-fg-subtle">
            {KIND[t.kind]} · difficulty {Math.round(t.difficulty)}/100 ({t.difficultySource === "dataforseo" ? "DataForSEO" : "proxy"})
          </p>
        </div>
        <p className="shrink-0 text-right">
          <span className="text-2xl font-semibold text-fg">{Math.round(t.score)}</span>
          <span className="text-xs text-fg-subtle"> / 100</span>
        </p>
      </div>
      <dl className="mt-3 grid grid-cols-4 gap-2 text-center text-xs">
        {(["demand", "trend", "fit", "ease"] as const).map((k) => (
          <div key={k} className="rounded-lg bg-surface-sunken px-2 py-1.5">
            <dt className="capitalize text-fg-subtle">{k}</dt>
            <dd className="font-semibold text-fg">{Math.round(t.parts[k] ?? 0)}</dd>
          </div>
        ))}
      </dl>
      <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-fg-muted">
        {t.reasons.map((r) => <li key={r}>{r}</li>)}
      </ul>
      {t.queries.length > 0 && <p className="mt-2 text-xs text-fg-subtle">Queries: {t.queries.slice(0, 6).join(", ")}</p>}
      {t.signals.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs">
          {t.signals.slice(0, 4).map((x) => (
            <li key={`${x.source}-${x.externalId}`} className="truncate">
              <span className="text-fg-subtle">{x.source}: </span>
              <a href={x.url} target="_blank" rel="noopener noreferrer nofollow" className="link">{x.title}</a>
            </li>
          ))}
        </ul>
      )}
      <form action={act} className="mt-4 flex flex-wrap gap-2">
        <input type="hidden" name="id" value={t.id} />
        <Button type="submit" name="what" value="calendar" size="sm">Add to calendar</Button>
        <Button type="submit" name="what" value="dismiss" size="sm" variant="secondary">Dismiss</Button>
      </form>
    </Card>
  );
}

function Check({ name, label, checked, hint }: { name: string; label: string; checked: boolean; hint?: string }) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" name={name} value="true" defaultChecked={checked} className="mt-0.5" />
      <span>
        {label}
        {hint && <span className="block text-xs text-fg-subtle">{hint}</span>}
      </span>
    </label>
  );
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function AutomationSection({ auto }: { auto: AutomationSettings }) {
  return (
    <section id="automation" aria-labelledby="automation-title" className="mb-10 scroll-mt-24">
      <h2 id="automation-title" className="mb-3 text-lg font-semibold text-fg">Automatic planning</h2>
      <Card>
        <p className="mb-5 text-sm text-fg-muted">
          Once a day the planner puts the best candidates on the <Link href="/admin/calendar" className="link">editorial calendar</Link> until the cadence below is met, counting items you added yourself. Each item&apos;s notes say why the
          topic was chosen and why that date. Nothing is published without your approval.
        </p>
        <form action={saveAutomation} className="grid gap-6">
          <Field label="Mode" htmlFor="mode">
            <Select id="mode" name="mode" defaultValue={auto.mode}>
              {MODES.map((m) => <option key={m} value={m}>{MODE_LABELS[m]}</option>)}
            </Select>
          </Field>
          <div className="grid gap-4 sm:grid-cols-4">
            <Field label="Articles" htmlFor="cadence-count"><Input id="cadence-count" name="cadence.count" type="number" min={1} max={31} defaultValue={auto.cadence.count} /></Field>
            <Field label="Per" htmlFor="cadence-period">
              <Select id="cadence-period" name="cadence.period" defaultValue={auto.cadence.period}>
                {PERIODS.map((p) => <option key={p} value={p}>{p}</option>)}
              </Select>
            </Field>
            <Field label={`Time (${EDITORIAL_TZ})`} htmlFor="time"><Input id="time" name="time" type="time" defaultValue={auto.time} /></Field>
            <Field label="Plan ahead (days)" htmlFor="horizonDays"><Input id="horizonDays" name="horizonDays" type="number" min={1} max={60} defaultValue={auto.horizonDays} /></Field>
          </div>
          <fieldset>
            <legend className="mb-2 text-sm font-semibold text-fg">Publishing days</legend>
            <div className="flex flex-wrap gap-4 text-sm">
              {DAY_NAMES.map((d, i) => (
                <label key={d} className="flex items-center gap-1.5"><input type="checkbox" name="days" value={i} defaultChecked={auto.days.includes(i)} /> {d}</label>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-4 sm:grid-cols-4">
            <Field label="Minimum score to plan" htmlFor="autoMinScore"><Input id="autoMinScore" name="autoMinScore" type="number" min={0} max={100} defaultValue={auto.minScore} /></Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit">Save automatic planning</Button>
            <Button type="submit" formAction={planNow} variant="secondary">Plan now</Button>
          </div>
        </form>
      </Card>
    </section>
  );
}

export default async function TopicsPage({ searchParams }: { searchParams: FlashParams }) {
  const db = await getDb();
  const [s, auto, topics, sp] = await Promise.all([getTopicsSettings(), getAutomationSettings(), listTopics(db, "new", 60), searchParams]);
  const xReady = Boolean(process.env.X_BEARER_TOKEN?.trim());
  const dfsReady = Boolean(process.env.DATAFORSEO_LOGIN?.trim() && process.env.DATAFORSEO_PASSWORD?.trim());
  return (
    <>
      <AdminHeader
        title="Topic discovery"
        description={
          <>
            Topics worth writing next, from Search Console queries the site does not rank for yet and from what is trending on public developer sites. Each one shows why it is listed. Adding one creates an approved item in the{" "}
            <Link href="/admin/calendar" className="link">editorial calendar</Link>; nothing is drafted or published from this page.
          </>
        }
        actions={<form action={runNow}><Button type="submit" variant="secondary">Run discovery now</Button></form>}
      />
      <Flash ok={sp.ok} error={sp.error} />
      {!s.enabled && <p className="mb-6 rounded-lg border border-line bg-surface-sunken px-4 py-3 text-sm text-fg-muted">Topic discovery is switched off. Turn it on in the settings below.</p>}
      <section aria-labelledby="topics-title" className="mb-10">
        <h2 id="topics-title" className="mb-3 text-lg font-semibold text-fg">Candidates ({topics.length})</h2>
        {topics.length === 0 ? (
          <Card><p className="text-sm text-fg-muted">No candidates yet. The discovery job runs daily; you can also start it with the button above.</p></Card>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">{topics.map((t) => <TopicCard key={t.id} t={t} />)}</div>
        )}
      </section>
      <AutomationSection auto={auto} />
      <section id="settings" aria-labelledby="settings-title" className="scroll-mt-24">
        <h2 id="settings-title" className="mb-3 text-lg font-semibold text-fg">Settings</h2>
        <Card>
          <form action={saveSettings} className="grid gap-6">
            <Check name="enabled" label="Topic discovery is on" checked={s.enabled} hint="Off: the daily job does nothing." />
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-sm font-semibold text-fg">Sources</legend>
              {SOURCE_IDS.map((id) => (
                <Check key={id} name={`source.${id}`} label={SOURCE_LABELS[id]} checked={s.sources[id]} hint={id === "x" ? (xReady ? "Bearer token saved." : "No bearer token yet: save X_BEARER_TOKEN in Advanced settings → Research sources. Until then this source is skipped.") : undefined} />
              ))}
            </fieldset>
            <fieldset className="grid gap-3">
              <legend className="mb-1 text-sm font-semibold text-fg">Keyword difficulty</legend>
              <Check name="dataForSeo.enabled" label="Use DataForSEO for keyword difficulty" checked={s.dataForSeo.enabled} hint={dfsReady ? "Login saved. Off: the built-in proxy is used." : "No login yet: save DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD in Advanced settings → Research sources. Until then the built-in proxy is used."} />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="DataForSEO location code" htmlFor="dfs-loc" hint="2840 = United States."><Input id="dfs-loc" name="dataForSeo.locationCode" type="number" min={1} max={99999} defaultValue={s.dataForSeo.locationCode} /></Field>
                <Field label="DataForSEO language" htmlFor="dfs-lang"><Input id="dfs-lang" name="dataForSeo.languageCode" defaultValue={s.dataForSeo.languageCode} maxLength={2} /></Field>
              </div>
            </fieldset>
            <Field label="Subjects the site writes about" htmlFor="terms" hint="One per line or comma-separated. A query or trend item must contain one of these to be considered.">
              <Textarea id="terms" name="terms" rows={4} defaultValue={s.terms.join(", ")} spellCheck={false} />
            </Field>
            <fieldset>
              <legend className="mb-2 text-sm font-semibold text-fg">Score weights</legend>
              <div className="grid gap-4 sm:grid-cols-4">
                {(["demand", "trend", "fit", "ease"] as const).map((k) => (
                  <Field key={k} label={k.charAt(0).toUpperCase() + k.slice(1)} htmlFor={`w-${k}`}><Input id={`w-${k}`} name={`weight.${k}`} type="number" min={0} max={100} defaultValue={s.weights[k]} /></Field>
                ))}
              </div>
            </fieldset>
            <div className="grid gap-4 sm:grid-cols-4">
              <Field label="Minimum score" htmlFor="minScore"><Input id="minScore" name="minScore" type="number" min={0} max={100} defaultValue={s.minScore} /></Field>
              <Field label="Minimum impressions (28 days)" htmlFor="minImpressions"><Input id="minImpressions" name="minImpressions" type="number" min={1} max={100000} defaultValue={s.minImpressions} /></Field>
              <Field label="Hacker News minimum points" htmlFor="hnMinPoints"><Input id="hnMinPoints" name="hnMinPoints" type="number" min={0} max={10000} defaultValue={s.hnMinPoints} /></Field>
              <Field label="Candidates kept" htmlFor="maxCandidates"><Input id="maxCandidates" name="maxCandidates" type="number" min={5} max={200} defaultValue={s.maxCandidates} /></Field>
            </div>
            <div><Button type="submit">Save settings</Button></div>
          </form>
        </Card>
      </section>
    </>
  );
}
