import { SectionHeading } from "@/components/admin/SettingsParts";
import { Card, StatusPill } from "@/components/admin/ui";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { Button, Field, Input } from "@/components/ui/form";
import { siteUrl } from "@/config/site";
import { adminActor } from "@/lib/admin";
import { callbackUrl, providerLabels, SOCIAL_PROVIDERS, type SocialProvider } from "@/lib/auth-providers";
import { flash } from "@/lib/flash";
import { resetSocialProvider, saveSocialProvider, socialSummary } from "@/lib/integrations";
import { settingsHref } from "@/lib/settings-areas";
import { SOURCE } from "./source";

const CONSOLE: Record<SocialProvider, { href: string; label: string; steps: string }> = {
  google: {
    href: "https://console.cloud.google.com/apis/credentials",
    label: "Google Cloud console → APIs & Services → Credentials",
    steps: "Create an OAuth client ID of type “Web application”, add the redirect URI below, and keep the consent screen to the email and profile scopes.",
  },
  github: {
    href: "https://github.com/settings/developers",
    label: "GitHub → Settings → Developer settings → OAuth Apps",
    steps: "Register a new OAuth App with this site as the homepage and the callback URL below, then generate a client secret.",
  },
};

async function saveProvider(form: FormData) {
  "use server";
  const actor = await adminActor();
  const provider = String(form.get("provider")) as SocialProvider;
  await flash(settingsHref("social"), async () => {
    if (form.get("intent") === "reset") {
      await resetSocialProvider(actor, provider);
      return `${providerLabels[provider]} now follows the deployment's environment variables.`;
    }
    await saveSocialProvider(actor, provider, { enabled: form.has("enabled"), clientId: String(form.get("clientId") ?? ""), clientSecret: String(form.get("clientSecret") ?? "") });
    return form.has("enabled") ? `${providerLabels[provider]} sign-in is on.` : `${providerLabels[provider]} sign-in is off.`;
  });
}

/** Settings → Users & access → Social sign-in (Settings → Integrations until 2026-11-26). */
export default async function SocialSection() {
  const social = await socialSummary();
  const origin = siteUrl();
  return (
    <section aria-labelledby="social-title" className="space-y-4">
      <SectionHeading
        id="social-title"
        title="Social sign-in"
        description={
          <>
            Readers can sign in or register with these providers (registration follows the “Reader sign-up” switch in Appearance → General). Accounts are never linked by matching email;
            people connect providers themselves in Account → Settings. Changes apply to new sign-ins immediately. Secrets are encrypted at rest and never shown again.
          </>
        }
      />
      {SOCIAL_PROVIDERS.map((p) => {
        const s = social.find((x) => x.provider === p)!;
        const help = CONSOLE[p];
        return (
          <Card key={p}>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-semibold text-fg">{providerLabels[p]}</h3>
              <div className="flex items-center gap-2 text-xs text-fg-subtle">
                {s.source !== "none" && SOURCE[s.source]}
                <StatusPill status={s.enabled ? "ok" : s.source === "none" ? "not configured" : "closed"} />
              </div>
            </div>
            <p className="mb-4 text-sm text-fg-muted">
              <a href={help.href} target="_blank" rel="noopener noreferrer" className="link">{help.label}</a>. {help.steps}
            </p>
            <div className="mb-4">
              <Field label="Authorized redirect / callback URL" htmlFor={`cb-${p}`} hint="Register exactly this URL with the provider.">
                <Input id={`cb-${p}`} readOnly value={callbackUrl(origin, p)} className="font-mono text-xs" />
              </Field>
            </div>
            <form action={saveProvider} className="grid gap-4 sm:grid-cols-2">
              <input type="hidden" name="provider" value={p} />
              <Field label="Client ID" htmlFor={`id-${p}`}>
                <Input id={`id-${p}`} name="clientId" defaultValue={s.clientId} autoComplete="off" spellCheck={false} />
              </Field>
              <Field label="Client secret" htmlFor={`secret-${p}`} hint={s.hasSecret ? "Stored. Leave empty to keep it." : undefined}>
                <PasswordInput id={`secret-${p}`} name="clientSecret" autoComplete="off" />
              </Field>
              <label className="flex items-center gap-2 text-sm sm:col-span-2">
                <input type="checkbox" name="enabled" defaultChecked={s.enabled} /> Allow sign-in with {providerLabels[p]}
              </label>
              <div className="flex flex-wrap gap-2 sm:col-span-2">
                <Button type="submit" name="intent" value="save">Save</Button>
                {s.source === "admin" && (
                  <Button type="submit" name="intent" value="reset" variant="ghost">Use environment instead</Button>
                )}
              </div>
            </form>
          </Card>
        );
      })}
    </section>
  );
}
