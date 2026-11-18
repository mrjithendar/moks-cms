"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Card } from "@/components/admin/ui";
import { Alert, Button, Field, Input, Select, Textarea } from "@/components/ui/form";
import { ASK_ALWAYS_HIDDEN } from "@/components/ask/types";
import type { AskSettings, AskStatus } from "@/lib/seo-agent/ask-settings";

type Props = {
  initial: AskSettings;
  defaults: AskSettings;
  /** ASK_BLOG_ENABLED in the web app's environment: the deployment's master switch. */
  envEnabled: boolean;
  status: AskStatus | null;
  /** Recall@3 of the last live retrieval evaluation (0–1), when there is one. */
  recall3: number | null;
};

const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * Automation & AI → "Ask the Blog": the admin's switch, who may use the assistant (signed-in readers or everyone),
 * where the widget shows, its text, the per-reader limits, the daily budget and the answer style, plus read-only
 * status numbers. Saved as one document through PUT /api/admin/seo/ask-blog (validated and audit-logged on the
 * server); the web app applies it at once, the seo-agent within about 30 seconds.
 */
export function AskBlogSettingsCard({ initial, defaults, envEnabled, status, recall3 }: Props) {
  const router = useRouter();
  const [s, setS] = useState<AskSettings>(initial);
  const [examples, setExamples] = useState(initial.copy.examples.join("\n"));
  const [hideOn, setHideOn] = useState(initial.sitewide.hideOn.join("\n"));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; issues?: string[] } | null>(null);

  const set = <K extends keyof AskSettings>(k: K, v: AskSettings[K]) => setS((p) => ({ ...p, [k]: v }));
  const setCopy = (k: keyof AskSettings["copy"], v: string) => setS((p) => ({ ...p, copy: { ...p.copy, [k]: v } }));
  const setLimit = (k: keyof AskSettings["limits"], v: string) => setS((p) => ({ ...p, limits: { ...p.limits, [k]: Number(v) } }));
  const setSitewide = <K extends keyof AskSettings["sitewide"]>(k: K, v: AskSettings["sitewide"][K]) => setS((p) => ({ ...p, sitewide: { ...p.sitewide, [k]: v } }));
  const setConv = <K extends keyof AskSettings["conversation"]>(k: K, v: AskSettings["conversation"][K]) => setS((p) => ({ ...p, conversation: { ...p.conversation, [k]: v } }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (s.enabled && !initial.enabled && !window.confirm(`Turn Ask the Blog on for ${s.audience === "members" ? "signed-in readers" : "everyone"}? Each answer costs money, up to the daily budget.`)) return;
    setBusy(true);
    setMsg(null);
    const lines = (t: string) => t.split("\n").map((x) => x.trim()).filter(Boolean);
    const body: AskSettings = { ...s, sitewide: { ...s.sitewide, hideOn: lines(hideOn) }, copy: { ...s.copy, examples: lines(examples) } };
    try {
      const res = await fetch("/api/admin/seo/ask-blog", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = (await res.json().catch(() => ({}))) as { error?: string; issues?: string[]; reference?: string; settings?: AskSettings };
      if (!res.ok) setMsg({ ok: false, text: (data.error ?? `HTTP ${res.status}`) + (data.reference ? ` (ref ${data.reference})` : ""), issues: data.issues });
      else {
        if (data.settings) {
          setS(data.settings);
          setExamples(data.settings.copy.examples.join("\n"));
          setHideOn(data.settings.sitewide.hideOn.join("\n"));
        }
        setMsg({ ok: true, text: "Saved. The site applies it now; the assistant within about 30 seconds." });
        router.refresh();
      }
    } catch {
      setMsg({ ok: false, text: "Network error." });
    } finally {
      setBusy(false);
    }
  }

  const live = envEnabled && initial.enabled;
  return (
    <Card className="mb-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold text-fg">Ask the Blog</h2>
        <span className={`text-sm font-medium ${live ? "text-green-700 dark:text-green-400" : "text-fg-muted"}`}>{live ? `On for ${initial.audience === "members" ? "signed-in readers" : "everyone"}` : "Off"}</span>
      </div>
      <p className="mt-1 text-sm text-fg-muted">The public assistant that answers readers&apos; questions from the articles on this site, with citations. Changes are audit-logged.</p>
      {!envEnabled && (
        <div className="mt-3">
          <Alert tone="info">
            The deployment switch <code>ASK_BLOG_ENABLED</code> is off for the web app, so the assistant stays off whatever is saved here. See docs/seo/MANUAL_SETUP.md §18.
          </Alert>
        </div>
      )}

      <dl className="mt-4 grid gap-3 border-y border-line py-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-fg-subtle">Spent today (UTC)</dt>
          <dd className="font-medium tabular-nums text-fg">{status ? `${usd(status.spentTodayUsd)} of ${usd(initial.dailyBudgetUsd)}` : "—"}</dd>
        </div>
        <div>
          <dt className="text-fg-subtle">Questions, last 7 days</dt>
          <dd className="font-medium tabular-nums text-fg">{status ? `${status.week.total} (${status.week.answered} answered, ${status.week.fallback} no article, ${status.week.refused} refused)` : "—"}</dd>
        </div>
        <div>
          <dt className="text-fg-subtle">Open content gaps</dt>
          <dd className="font-medium tabular-nums text-fg">{status ? <Link className="underline" href="/admin/keywords?view=gaps">{status.openGaps}</Link> : "—"}</dd>
        </div>
        <div>
          <dt className="text-fg-subtle">Retrieval Recall@3 (last live run)</dt>
          <dd className="font-medium tabular-nums text-fg">{recall3 === null ? "—" : `${(recall3 * 100).toFixed(1)} %`}</dd>
        </div>
        <div>
          <dt className="text-fg-subtle">Follow-up questions, last 7 days</dt>
          <dd className="font-medium tabular-nums text-fg">{status ? status.week.followUps : "—"}</dd>
        </div>
        <div>
          <dt className="text-fg-subtle">Reader feedback, last 7 days</dt>
          <dd className="font-medium tabular-nums text-fg">{status ? `${status.week.helpful} helpful, ${status.week.notHelpful} not helpful` : "—"}</dd>
        </div>
      </dl>

      <form onSubmit={save} className="mt-4 space-y-6">
        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold text-fg">Availability</legend>
          <label className="flex items-center gap-2 text-sm text-fg">
            <input type="checkbox" checked={s.enabled} onChange={(e) => set("enabled", e.target.checked)} />
            Ask the Blog is on
          </label>
          <div role="radiogroup" aria-label="Who can use it" className="space-y-2">
            <p className="text-sm font-medium text-fg">Who can use it</p>
            <label className="flex items-start gap-2 text-sm text-fg">
              <input type="radio" name="ask-audience" className="mt-0.5" checked={s.audience === "members"} onChange={() => set("audience", "members")} />
              <span>
                Signed-in readers only
                <span className="block text-fg-subtle">Signed-out readers see a prompt to sign in. Limits count per account as well as per IP address. The public MCP tool <code>ask_blog</code> is off in this mode.</span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm text-fg">
              <input type="radio" name="ask-audience" className="mt-0.5" checked={s.audience === "everyone"} onChange={() => set("audience", "everyone")} />
              <span>
                Everyone
                <span className="block text-fg-subtle">Anyone visiting the site can ask, within the limits below.</span>
              </span>
            </label>
          </div>
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold text-fg">Where it appears</legend>
          <label className="flex items-start gap-2 text-sm text-fg">
            <input type="checkbox" className="mt-0.5" checked={s.sitewide.enabled} onChange={(e) => setSitewide("enabled", e.target.checked)} />
            <span>
              Show the chat on every page
              <span className="block text-fg-subtle">A button in the bottom-right corner of every public page opens the chat. The conversation stays open while the reader moves around the site.</span>
            </span>
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Chat button" htmlFor="ask-launcher">
              <Select id="ask-launcher" value={s.sitewide.launcher} disabled={!s.sitewide.enabled} onChange={(e) => setSitewide("launcher", e.target.value as AskSettings["sitewide"]["launcher"])}>
                <option value="pill">Icon and button label (shrinks to the icon after scrolling)</option>
                <option value="icon">Round icon only</option>
              </Select>
            </Field>
            <Field label="Also hide it on" htmlFor="ask-hide-on" hint={`One path per line, e.g. /python-practice. Always hidden on ${ASK_ALWAYS_HIDDEN.join(", ")}.`} optional>
              <Textarea id="ask-hide-on" rows={3} value={hideOn} disabled={!s.sitewide.enabled} onChange={(e) => setHideOn(e.target.value)} />
            </Field>
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <span className="text-sm font-medium text-fg">Card at the end of the</span>
            <label className="flex items-center gap-2 text-sm text-fg">
              <input type="checkbox" checked={s.placement.home} onChange={(e) => set("placement", { ...s.placement, home: e.target.checked })} />
              Home page
            </label>
            <label className="flex items-center gap-2 text-sm text-fg">
              <input type="checkbox" checked={s.placement.articles} onChange={(e) => set("placement", { ...s.placement, articles: e.target.checked })} />
              Article pages
            </label>
          </div>
          <p className="text-sm text-fg-subtle">With the chat on every page, the card&apos;s button opens the same chat. Without it, the card expands into the chat in place.</p>
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold text-fg">Conversation</legend>
          <label className="flex items-start gap-2 text-sm text-fg">
            <input type="checkbox" className="mt-0.5" checked={s.conversation.followUps} onChange={(e) => setConv("followUps", e.target.checked)} />
            <span>
              Understand follow-up questions
              <span className="block text-fg-subtle">Sends the earlier turns with a question, so &quot;and where is the token stored?&quot; is understood. The agent rewrites it as a standalone question first (one small extra call, within the daily budget). Off: each question is answered on its own.</span>
            </span>
          </label>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Earlier turns to send" htmlFor="ask-turns" hint="1 to 5">
              <Input id="ask-turns" type="number" min={1} max={5} step={1} required disabled={!s.conversation.followUps} value={s.conversation.turns} onChange={(e) => setConv("turns", Number(e.target.value))} />
            </Field>
          </div>
          <label className="flex items-start gap-2 text-sm text-fg">
            <input type="checkbox" className="mt-0.5" checked={s.conversation.pageContext} onChange={(e) => setConv("pageContext", e.target.checked)} />
            <span>
              Prefer the article the reader has open
              <span className="block text-fg-subtle">On article pages, that article&apos;s sections rank a little higher. Other articles can still answer.</span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm text-fg">
            <input type="checkbox" className="mt-0.5" checked={s.conversation.keepThread} onChange={(e) => setConv("keepThread", e.target.checked)} />
            <span>
              Keep the conversation when the page reloads
              <span className="block text-fg-subtle">Kept in the reader&apos;s browser tab only, until the tab is closed or they start a new chat. Nothing extra is stored on the server.</span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm text-fg">
            <input type="checkbox" className="mt-0.5" checked={s.conversation.feedback} onChange={(e) => setConv("feedback", e.target.checked)} />
            <span>
              Ask readers whether an answer helped
              <span className="block text-fg-subtle">Helpful / Not helpful under each answer, saved with the question, without the reader&apos;s account or IP address.</span>
            </span>
          </label>
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold text-fg">Widget text</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Button label" htmlFor="ask-button">
              <Input id="ask-button" value={s.copy.button} maxLength={40} required onChange={(e) => setCopy("button", e.target.value)} />
            </Field>
            <Field label="Question box placeholder" htmlFor="ask-placeholder" optional>
              <Input id="ask-placeholder" value={s.copy.placeholder} maxLength={120} onChange={(e) => setCopy("placeholder", e.target.value)} />
            </Field>
          </div>
          <Field label="Intro line" htmlFor="ask-intro">
            <Input id="ask-intro" value={s.copy.intro} maxLength={200} required onChange={(e) => setCopy("intro", e.target.value)} />
          </Field>
          <Field label="Note under the answer" htmlFor="ask-disclaimer" hint="Keep it true: questions are stored without the reader's IP address or account.">
            <Input id="ask-disclaimer" value={s.copy.disclaimer} maxLength={300} required onChange={(e) => setCopy("disclaimer", e.target.value)} />
          </Field>
          <Field label="Example questions" htmlFor="ask-examples" hint="One per line, up to four. Shown as buttons that ask the question." optional>
            <Textarea id="ask-examples" rows={3} value={examples} onChange={(e) => setExamples(e.target.value)} />
          </Field>
          <Field label="When no article answers the question" htmlFor="ask-fallback">
            <Input id="ask-fallback" value={s.fallbackMessage} maxLength={200} required onChange={(e) => set("fallbackMessage", e.target.value)} />
          </Field>
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold text-fg">Limits, cost and answers</legend>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Questions per reader per minute" htmlFor="ask-per-minute" hint={`Default ${defaults.limits.perMinute}`}>
              <Input id="ask-per-minute" type="number" min={1} max={30} step={1} required value={s.limits.perMinute} onChange={(e) => setLimit("perMinute", e.target.value)} />
            </Field>
            <Field label="Questions per reader per day" htmlFor="ask-per-day" hint={`Default ${defaults.limits.perDay}`}>
              <Input id="ask-per-day" type="number" min={1} max={1000} step={1} required value={s.limits.perDay} onChange={(e) => setLimit("perDay", e.target.value)} />
            </Field>
            <Field label="Longest question (characters)" htmlFor="ask-max-question" hint="50 to 500">
              <Input id="ask-max-question" type="number" min={50} max={500} step={1} required value={s.limits.maxQuestion} onChange={(e) => setLimit("maxQuestion", e.target.value)} />
            </Field>
            <Field label="Daily budget (USD)" htmlFor="ask-budget" hint="Never above the agent's ASK_BLOG_DAILY_BUDGET_USD.">
              <Input id="ask-budget" type="number" min={0.05} max={50} step={0.05} required value={s.dailyBudgetUsd} onChange={(e) => set("dailyBudgetUsd", Number(e.target.value))} />
            </Field>
            <Field label="Reuse an answer for (seconds)" htmlFor="ask-cache" hint="Same question, same index. 0 turns reuse off.">
              <Input id="ask-cache" type="number" min={0} max={86400} step={1} required value={s.cacheTtlSeconds} onChange={(e) => set("cacheTtlSeconds", Number(e.target.value))} />
            </Field>
            <Field label="Answer length" htmlFor="ask-length">
              <Select id="ask-length" value={s.answerLength} onChange={(e) => set("answerLength", e.target.value as AskSettings["answerLength"])}>
                <option value="short">Short (up to 3 sentences)</option>
                <option value="standard">Standard (up to 6 sentences)</option>
                <option value="detailed">Detailed (up to 10 sentences)</option>
              </Select>
            </Field>
          </div>
          <p className="text-sm text-fg-subtle">Retrieval (top 6 excerpts, score floor 0.66) is set from the evaluation set and is not editable here: see ML models &amp; retrieval above.</p>
        </fieldset>

        {msg && (
          <Alert tone={msg.ok ? "success" : "error"}>
            {msg.text}
            {msg.issues?.length ? (
              <ul className="mt-1 list-disc pl-5">
                {msg.issues.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
            ) : null}
          </Alert>
        )}
        <div className="flex gap-2">
          <Button type="submit" loading={busy}>
            Save Ask the Blog settings
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setS({ ...defaults, enabled: s.enabled, audience: s.audience, sitewide: s.sitewide, conversation: s.conversation });
              setExamples(defaults.copy.examples.join("\n"));
            }}
          >
            Reset text and limits to defaults
          </Button>
        </div>
      </form>
    </Card>
  );
}
