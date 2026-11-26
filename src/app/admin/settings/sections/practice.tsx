import { SectionHeading, SeeAlso } from "@/components/admin/SettingsParts";
import { Card } from "@/components/admin/ui";
import { Button, Field, Input, Select, Textarea } from "@/components/ui/form";
import { adminActor } from "@/lib/admin";
import { flash } from "@/lib/flash";
import { AI_PROVIDERS, clearAiKey, getPracticeSettings, savePracticeSettings } from "@/lib/practice/settings";
import { settingsHref } from "@/lib/settings-areas";

const num = (f: FormData, k: string) => Number(f.get(k));

async function save(form: FormData) {
  "use server";
  const actor = await adminActor();
  await flash(settingsHref("practice"), async () => {
    const runtimes = String(form.get("runtimes") ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [id, label, state] = l.split("|").map((s) => s.trim());
        return { id: id ?? "", label: label || id || "", enabled: state !== "off" };
      });
    await savePracticeSettings(actor, {
      execution: { enabled: form.get("executionEnabled") === "on", runtimes, defaultRuntime: String(form.get("defaultRuntime") ?? ""), perTestSeconds: num(form, "perTestSeconds"), totalSeconds: num(form, "totalSeconds"), memoryMb: num(form, "memoryMb") },
      quotas: { runsPerHour: num(form, "runsPerHour"), submitsPerHour: num(form, "submitsPerHour"), maxPending: num(form, "maxPending"), aiRequestsPerDay: num(form, "aiRequestsPerDay"), aiDailyBudgetUsd: num(form, "aiDailyBudgetUsd") },
      ai: {
        enabled: form.get("aiEnabled") === "on",
        provider: String(form.get("provider")),
        model: String(form.get("model") ?? ""),
        baseUrl: String(form.get("baseUrl") ?? ""),
        region: String(form.get("region") ?? "us-east-1"),
        apiKey: String(form.get("apiKey") ?? ""),
        timeoutMs: num(form, "timeoutMs"),
        maxOutputTokens: num(form, "maxOutputTokens"),
        inputUsdPerMTok: num(form, "inputUsdPerMTok"),
        outputUsdPerMTok: num(form, "outputUsdPerMTok"),
      },
      leaderboard: { enabled: form.get("leaderboardEnabled") === "on" },
      retention: { activityDays: num(form, "activityDays"), codeDays: num(form, "codeDays") },
    });
    return "Settings saved.";
  });
}

async function removeKey() {
  "use server";
  const actor = await adminActor();
  await flash(settingsHref("practice"), async () => {
    await clearAiKey(actor);
    return "AI key removed.";
  });
}

/** Settings → Practice → Python practice (the last card of Admin → Practice until 2026-11-26). */
export default async function PracticeSection() {
  const s = await getPracticeSettings();
  return (
    <section aria-labelledby="practice-title" className="space-y-4">
      <SectionHeading id="practice-title" title="Python practice" description="Code execution, quotas, the AI tutor, the public leaderboard and how long activity and code are kept, for /python-practice." />
      <Card>
        <form action={save} className="space-y-8">
          <fieldset className="grid gap-4 sm:grid-cols-3">
            <legend className="mb-2 text-sm font-semibold text-fg">Execution</legend>
            <label className="flex items-center gap-2 text-sm sm:col-span-3">
              <input type="checkbox" name="executionEnabled" defaultChecked={s.execution.enabled} /> Allow running and submitting code
            </label>
            <div className="sm:col-span-2">
              <Field label="Runtimes (id | label | on/off, one per line)" htmlFor="runtimes" hint="Ids must match EXECUTOR_RUNTIMES in the executor deployment.">
                <Textarea id="runtimes" name="runtimes" rows={3} className="font-mono text-sm" spellCheck={false} defaultValue={s.execution.runtimes.map((r) => `${r.id} | ${r.label} | ${r.enabled ? "on" : "off"}`).join("\n")} />
              </Field>
            </div>
            <Field label="Default runtime" htmlFor="defaultRuntime"><Input id="defaultRuntime" name="defaultRuntime" defaultValue={s.execution.defaultRuntime} /></Field>
            <Field label="Max seconds per test" htmlFor="perTestSeconds"><Input id="perTestSeconds" name="perTestSeconds" type="number" step="0.5" defaultValue={s.execution.perTestSeconds} /></Field>
            <Field label="Max seconds per run" htmlFor="totalSeconds"><Input id="totalSeconds" name="totalSeconds" type="number" defaultValue={s.execution.totalSeconds} /></Field>
            <Field label="Max memory (MB)" htmlFor="memoryMb"><Input id="memoryMb" name="memoryMb" type="number" defaultValue={s.execution.memoryMb} /></Field>
          </fieldset>
          <fieldset className="grid gap-4 sm:grid-cols-3">
            <legend className="mb-2 text-sm font-semibold text-fg">Quotas</legend>
            <Field label="Runs per user per hour" htmlFor="runsPerHour"><Input id="runsPerHour" name="runsPerHour" type="number" defaultValue={s.quotas.runsPerHour} /></Field>
            <Field label="Submissions per user per hour" htmlFor="submitsPerHour"><Input id="submitsPerHour" name="submitsPerHour" type="number" defaultValue={s.quotas.submitsPerHour} /></Field>
            <Field label="Concurrent runs per user" htmlFor="maxPending"><Input id="maxPending" name="maxPending" type="number" defaultValue={s.quotas.maxPending} /></Field>
            <Field label="AI requests per user per day" htmlFor="aiRequestsPerDay"><Input id="aiRequestsPerDay" name="aiRequestsPerDay" type="number" defaultValue={s.quotas.aiRequestsPerDay} /></Field>
            <Field label="AI budget per day (USD)" htmlFor="aiDailyBudgetUsd"><Input id="aiDailyBudgetUsd" name="aiDailyBudgetUsd" type="number" step="0.01" defaultValue={s.quotas.aiDailyBudgetUsd} /></Field>
          </fieldset>
          <fieldset className="grid gap-4 sm:grid-cols-3">
            <legend className="mb-2 text-sm font-semibold text-fg">AI tutor</legend>
            <label className="flex items-center gap-2 text-sm sm:col-span-3">
              <input type="checkbox" name="aiEnabled" defaultChecked={s.ai.enabled} /> Enable the AI tutor
            </label>
            <Field label="Provider" htmlFor="provider">
              <Select id="provider" name="provider" defaultValue={s.ai.provider}>
                {AI_PROVIDERS.map((p) => (
                  <option key={p} value={p}>{p === "openai" ? "OpenAI-compatible" : p === "gemini" ? "Google Gemini" : "Amazon Bedrock"}</option>
                ))}
              </Select>
            </Field>
            <Field label="Model id" htmlFor="model" hint="Exactly as the provider names it."><Input id="model" name="model" defaultValue={s.ai.model} /></Field>
            <Field label="Base URL (OpenAI-compatible)" htmlFor="baseUrl" optional><Input id="baseUrl" name="baseUrl" defaultValue={s.ai.baseUrl} placeholder="https://api.openai.com/v1" /></Field>
            <Field label="Bedrock region" htmlFor="region"><Input id="region" name="region" defaultValue={s.ai.region} /></Field>
            <Field label="API key" htmlFor="apiKey" hint={s.ai.apiKey ? "A key is saved (encrypted). Leave empty to keep it." : "Falls back to OPENAI_API_KEY / GEMINI_API_KEY. Bedrock uses AWS credentials, not a key."}>
              <Input id="apiKey" name="apiKey" type="password" autoComplete="off" />
            </Field>
            <Field label="Timeout (ms)" htmlFor="timeoutMs"><Input id="timeoutMs" name="timeoutMs" type="number" defaultValue={s.ai.timeoutMs} /></Field>
            <Field label="Max output tokens" htmlFor="maxOutputTokens"><Input id="maxOutputTokens" name="maxOutputTokens" type="number" defaultValue={s.ai.maxOutputTokens} /></Field>
            <Field label="Input price (USD per million tokens)" htmlFor="inputUsdPerMTok"><Input id="inputUsdPerMTok" name="inputUsdPerMTok" type="number" step="0.001" defaultValue={s.ai.inputUsdPerMTok} /></Field>
            <Field label="Output price (USD per million tokens)" htmlFor="outputUsdPerMTok"><Input id="outputUsdPerMTok" name="outputUsdPerMTok" type="number" step="0.001" defaultValue={s.ai.outputUsdPerMTok} /></Field>
          </fieldset>
          <fieldset className="grid gap-4 sm:grid-cols-3">
            <legend className="mb-2 text-sm font-semibold text-fg">Community and retention</legend>
            <label className="flex items-center gap-2 text-sm sm:col-span-3">
              <input type="checkbox" name="leaderboardEnabled" defaultChecked={s.leaderboard.enabled} /> Public leaderboard (opt-in per user)
            </label>
            <Field label="Keep activity events (days)" htmlFor="activityDays"><Input id="activityDays" name="activityDays" type="number" defaultValue={s.retention.activityDays} /></Field>
            <Field label="Keep submitted code (days)" htmlFor="codeDays"><Input id="codeDays" name="codeDays" type="number" defaultValue={s.retention.codeDays} /></Field>
          </fieldset>
          <Button type="submit">Save settings</Button>
        </form>
        {s.ai.apiKey && (
          <form action={removeKey} className="mt-3">
            <Button type="submit" variant="ghost" size="sm">Remove saved AI key</Button>
          </form>
        )}
      </Card>
      <SeeAlso href="/admin/practice">Practice → Python practice: problems, the code runner&apos;s state and abuse signals</SeeAlso>
    </section>
  );
}
