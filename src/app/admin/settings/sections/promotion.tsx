import { SectionHeading, SeeAlso } from "@/components/admin/SettingsParts";
import { Card } from "@/components/admin/ui";
import { ApiButton } from "@/components/seo/ApiButton";
import { PromotionSettingsForm } from "@/components/seo/PromotionSettingsForm";
import { fmtInt, fmtWhen } from "@/components/seo/ui";
import { CHANNELS } from "@/lib/seo-intel/promotion/channels";
import { redditState } from "@/lib/seo-intel/promotion/reddit";
import { CHANNEL_IDS, getPromotionSettings } from "@/lib/seo-intel/promotion/settings";

/**
 * Settings → Content & publishing → Promotion (the Settings tab of Posts → Promotion until 2026-11-26): the read-only
 * Reddit connection, then the promotion settings document (channels, subreddits, link tags, limits; saved by PUT, audit-logged).
 */
export default async function PromotionSection() {
  const [settings, reddit] = await Promise.all([getPromotionSettings(), redditState()]);
  return (
    <section aria-labelledby="promotion-title" className="space-y-6">
      <SectionHeading
        id="promotion-title"
        title="Promotion"
        description="Where published articles are worth sharing, and the posts drafted for you to edit and post yourself. Nothing is posted automatically."
      />
      <section aria-labelledby="reddit-title" className="space-y-3">
        <h3 id="reddit-title" className="font-semibold text-fg">Reddit (read-only)</h3>
        <p className="text-sm text-fg-muted">Used to find threads about your subjects. The site only reads public listings; it never posts, votes or messages.</p>
        <Card>
          <p className="text-sm text-fg">
            {reddit.configured ? "Configured." : "Requires manual configuration."}{" "}
            <span className="text-fg-muted">
              {fmtInt(reddit.threads)} thread{reddit.threads === 1 ? "" : "s"} stored · last read {fmtWhen(reddit.lastFetched)}
            </span>
          </p>
          {!reddit.configured && (
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-fg-muted">
              <li>Create an app of type “script” at reddit.com/prefs/apps (Reddit may ask you to accept its API terms first).</li>
              <li>
                Put its client id and secret in the Secret <code>jithendar-com-env</code> as <code>REDDIT_CLIENT_ID</code> and <code>REDDIT_CLIENT_SECRET</code> (<code>scripts/set-reddit-config.sh</code>),
                then restart the site.
              </li>
              <li>Come back here and test the connection.</li>
            </ol>
          )}
          <div className="mt-3">
            <ApiButton url="/api/admin/seo/promotion/reddit/test" label="Test connection" />
          </div>
        </Card>
      </section>
      <section aria-labelledby="promotion-settings-title" className="space-y-3">
        <h3 id="promotion-settings-title" className="font-semibold text-fg">Promotion settings</h3>
        <Card>
          <PromotionSettingsForm settings={settings} channels={CHANNEL_IDS.map((id) => ({ id, label: CHANNELS[id].label }))} />
        </Card>
      </section>
      <SeeAlso href="/admin/promotion">Posts → Promotion: strategies, posts to review and content ideas</SeeAlso>
    </section>
  );
}
