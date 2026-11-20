import { saveRuntimeSettings } from "@/app/admin/_actions/runtime-settings";
import { Card, StatusPill } from "@/components/admin/ui";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { Button, Field, Input, Select, Textarea } from "@/components/ui/form";
import { GROUPS, runtimeSummary, type Field as SettingField, type FieldState, type Group } from "@/lib/runtime-settings";

/**
 * The forms for runtime settings (lib/runtime-settings.ts), shown on the page each group belongs to. A value saved
 * here overrides the deployment's environment variable of the same name; an empty field uses the deployment's value.
 *
 * layout "card": the title inside the card (pages whose cards carry their own titles: Storage, Bookings, Payments,
 * Users). layout "section": the title and description above the card (Integrations).
 */
export async function RuntimeSettings({ ids, layout = "card" }: { ids: string[]; layout?: "card" | "section" }) {
  const state = await runtimeSummary();
  const groups = ids.map((id) => {
    const g = GROUPS.find((x) => x.id === id);
    if (!g) throw new Error(`Unknown settings group ${id}`);
    return g;
  });
  return (
    <>
      {groups.map((g) => {
        const form = (
          <form action={saveRuntimeSettings} className="grid gap-4 sm:grid-cols-2">
            <input type="hidden" name="group" value={g.id} />
            {g.fields.map((f) => <Control key={f.env} f={f} s={state[f.env]!} />)}
            <div className="sm:col-span-2"><Button type="submit">Save</Button></div>
          </form>
        );
        const status = <StatusPill status={configured(g, state) ? "configured" : "not configured"} />;
        return layout === "section" ? (
          <section key={g.id} id={g.id} aria-labelledby={`${g.id}-title`} className="scroll-mt-24 space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <h2 id={`${g.id}-title`} className="text-lg font-semibold text-fg">{g.title}</h2>
                <p className="mt-1 text-sm text-fg-muted">{g.description}</p>
              </div>
              {status}
            </div>
            <Card>{form}</Card>
          </section>
        ) : (
          <section key={g.id} id={g.id} aria-labelledby={`${g.id}-title`} className="scroll-mt-24">
            <Card>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h2 id={`${g.id}-title`} className="font-semibold text-fg">{g.title}</h2>
                {status}
              </div>
              <p className="mb-4 text-sm text-fg-muted">{g.description}</p>
              {form}
            </Card>
          </section>
        );
      })}
    </>
  );
}

function configured(g: Group, state: Record<string, FieldState>): boolean {
  return g.fields.some((f) => state[f.env]!.value || state[f.env]!.hasSecret || state[f.env]!.fromDeployment || state[f.env]!.secretInDeployment);
}

/** Where the value in effect comes from, shown under each field. */
function source(f: SettingField, s: FieldState): string {
  if (f.type === "secret") return s.hasSecret ? "Stored here (encrypted). Leave empty to keep it." : s.secretInDeployment ? "Set in the deployment. Enter a value here to override it." : "Not set.";
  if (s.value) return s.fromDeployment ? "Set here (overrides the deployment)." : "Set here.";
  return s.fromDeployment ? `From the deployment: ${s.fromDeployment.length > 60 ? `${s.fromDeployment.slice(0, 60)}…` : s.fromDeployment}` : "Not set.";
}

function Control({ f, s }: { f: SettingField; s: FieldState }) {
  const id = `f-${f.env}`;
  const hint = [f.hint, source(f, s)].filter(Boolean).join(" ");
  if (f.type === "boolean") {
    return (
      <label className="flex items-start gap-2 text-sm sm:col-span-2">
        <input type="hidden" name={f.env} value="" />
        <input type="checkbox" name={f.env} value="true" defaultChecked={(s.value || s.fromDeployment) === "true"} className="mt-0.5" />
        <span>
          {f.label}
          <span className="block text-xs text-fg-subtle">{hint}</span>
        </span>
      </label>
    );
  }
  return (
    <div className={f.type === "textarea" ? "sm:col-span-2" : ""}>
      <Field label={f.label} htmlFor={id} hint={hint}>
        {f.type === "secret" ? (
          <PasswordInput id={id} name={f.env} autoComplete="off" />
        ) : f.type === "select" ? (
          <Select id={id} name={f.env} defaultValue={s.value}>
            <option value="">Deployment default{s.fromDeployment ? ` (${s.fromDeployment})` : ""}</option>
            {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
        ) : f.type === "textarea" ? (
          <Textarea id={id} name={f.env} rows={4} defaultValue={s.value} className="font-mono text-xs" spellCheck={false} />
        ) : (
          <Input id={id} name={f.env} type={f.type === "number" ? "number" : "text"} min={f.min} max={f.max} defaultValue={s.value} placeholder={s.fromDeployment ?? f.placeholder} autoComplete="off" spellCheck={false} />
        )}
      </Field>
      {f.type === "secret" && s.hasSecret && (
        <label className="mt-1.5 flex items-center gap-2 text-xs text-fg-muted">
          <input type="checkbox" name="clear" value={f.env} /> Remove the stored value
        </label>
      )}
    </div>
  );
}
