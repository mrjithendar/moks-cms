import { SectionHeading } from "@/components/admin/SettingsParts";
import { Card, StatusPill } from "@/components/admin/ui";
import { Alert, Button, Field, Input } from "@/components/ui/form";
import { isProductionEnv, siteUrl } from "@/config/site";
import { adminActor } from "@/lib/admin";
import { audit } from "@/lib/audit";
import { flash } from "@/lib/flash";
import { queueSitemapForIndexNow } from "@/lib/indexnow";
import { indexNowSummary, setIndexNow } from "@/lib/integrations";
import { settingsHref } from "@/lib/settings-areas";
import { SOURCE } from "./source";

async function indexNowAction(form: FormData) {
  "use server";
  const actor = await adminActor();
  const intent = String(form.get("intent"));
  await flash(settingsHref("indexnow"), async () => {
    if (intent === "submit-all") {
      const { queued, total } = await queueSitemapForIndexNow();
      await audit(actor, "integrations.indexnow.submit", undefined, { queued, total });
      return queued > 0 ? `${queued} of ${total} sitemap URLs queued for IndexNow; they are sent within a minute.` : "Nothing queued: IndexNow is off, or this is not the production site.";
    }
    await setIndexNow(actor, intent !== "off", { regenerate: intent === "regenerate" });
    return intent === "off" ? "IndexNow is off." : intent === "regenerate" ? "New IndexNow key generated." : "IndexNow is on. Publishing and updating posts now notifies Bing and other IndexNow engines.";
  });
}

/** Settings → Content & publishing → IndexNow (Settings → Integrations until 2026-11-26). */
export default async function IndexNowSection() {
  const indexNow = await indexNowSummary();
  const origin = siteUrl();
  return (
    <section aria-labelledby="indexnow-title" className="space-y-4">
      <SectionHeading
        id="indexnow-title"
        title="IndexNow"
        description="Tells Bing, Yandex, Seznam, Naver and other IndexNow search engines as soon as a post is published, updated or removed, so they recrawl it quickly. Google does not use IndexNow (it reads the sitemap). Submissions run in the background with retries and only from the production site."
      />
      <Card>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold text-fg">Instant indexing</h3>
          <div className="flex items-center gap-2 text-xs text-fg-subtle">
            {indexNow.source !== "none" && SOURCE[indexNow.source]}
            <StatusPill status={indexNow.enabled ? "ok" : "closed"} />
          </div>
        </div>
        {indexNow.key && (
          <div className="mb-4">
            <Field label="Key file" htmlFor="in-key" hint="Search engines fetch this file to confirm the key belongs to this site.">
              <Input id="in-key" readOnly value={`${origin}/${indexNow.key}.txt`} className="font-mono text-xs" />
            </Field>
            {indexNow.enabled && <a href={`/${indexNow.key}.txt`} target="_blank" rel="noopener" className="link mt-1 inline-block text-sm">Open key file ↗</a>}
          </div>
        )}
        {!isProductionEnv() && <div className="mb-4"><Alert tone="info">This is not the production site, so nothing is sent.</Alert></div>}
        {indexNow.source === "env" ? (
          <p className="text-sm text-fg-muted">Set by INDEXNOW_KEY in the deployment. Remove that variable to manage IndexNow here.</p>
        ) : (
          <form action={indexNowAction} className="flex flex-wrap gap-2">
            {indexNow.enabled ? (
              <>
                <Button type="submit" name="intent" value="submit-all" variant="secondary">Submit all pages now</Button>
                <Button type="submit" name="intent" value="regenerate" variant="ghost">New key</Button>
                <Button type="submit" name="intent" value="off" variant="ghost">Turn off</Button>
              </>
            ) : (
              <Button type="submit" name="intent" value="on">Turn on IndexNow</Button>
            )}
          </form>
        )}
        {indexNow.source === "env" && indexNow.enabled && (
          <form action={indexNowAction} className="mt-3"><Button type="submit" name="intent" value="submit-all" variant="secondary">Submit all pages now</Button></form>
        )}
      </Card>
    </section>
  );
}
