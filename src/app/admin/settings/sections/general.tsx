import Link from "next/link";
import type { ReactNode } from "react";
import { SectionHeading } from "@/components/admin/SettingsParts";
import { Card } from "@/components/admin/ui";
import { buttonClass } from "@/components/ui/form";
import { DATE_FORMATS } from "@/lib/site-config/schema";
import { getDraft, getDraftConfig, getPublishedConfig } from "@/lib/site-config/store";

/**
 * Settings → General. The site's identity, dates, contact, features and maintenance mode are part of the Appearance
 * draft (site_config: edited with a live preview, then published together with the rest of the design), so the
 * Appearance editor stays their one home and these sections link to it instead of drawing a second form for them.
 * Settings → General has opened Appearance → General since 2026-11-14; splitting it (docs/SETTINGS.md, decision D9) is
 * the owner's call.
 */

const APPEARANCE = (section: string) => `/admin/appearance?section=${section}`;

const onOff = (v: boolean) => (v ? "On" : "Off");
const NETWORK: Record<string, string> = { github: "GitHub", linkedin: "LinkedIn", x: "X", youtube: "YouTube", mastodon: "Mastodon" };

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 py-2.5 sm:grid-cols-[13rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-sm font-medium text-fg">{label}</dt>
      <dd className="text-sm text-fg-muted">{children || <span className="text-fg-subtle">Not set</span>}</dd>
    </div>
  );
}

/** Site identity: the published values, and whether the draft has changes waiting to be published. */
export async function SiteSection() {
  const [published, draft, draftConfig] = await Promise.all([getPublishedConfig(), getDraft(), getDraftConfig()]);
  const g = published.config.general;
  const pending = draft.version > 0 && JSON.stringify(draftConfig.general) !== JSON.stringify(g);
  const social = Object.entries(g.social).filter(([, url]) => url);
  return (
    <section aria-labelledby="site-title" className="space-y-4">
      <SectionHeading
        id="site-title"
        title="Site identity"
        description="What the site is called, its dates, contact details, features and maintenance mode, as readers see them now. They are edited in Appearance → General with a live preview and go live when the design is published."
        aside={
          <Link href={APPEARANCE("general")} className={buttonClass("primary", "sm")}>
            Edit in Appearance
          </Link>
        }
      />
      {pending && (
        <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
          The Appearance draft has changes to these settings that are not published yet. <Link href={APPEARANCE("general")} className="font-medium underline">Review and publish them</Link>.
        </p>
      )}
      <Card>
        <h3 className="font-semibold text-fg">Identity</h3>
        <dl className="mt-2 divide-y divide-line">
          <Row label="Site name">{g.siteName}</Row>
          <Row label="Publication name">{g.publicationName}</Row>
          <Row label="Tagline">{g.tagline}</Row>
          <Row label="Description">{g.description}</Row>
          <Row label="Editorial time zone">{g.timezone.replace("_", " ")}</Row>
          <Row label="Date format">{DATE_FORMATS[g.dateFormat]}</Row>
        </dl>
      </Card>
      <Card>
        <h3 className="font-semibold text-fg">Contact and social profiles</h3>
        <dl className="mt-2 divide-y divide-line">
          <Row label="Public contact email">{g.contact.email}</Row>
          <Row label="Location">{g.contact.location}</Row>
          <Row label="Social profiles">
            {social.length > 0 && (
              <ul className="space-y-1">
                {social.map(([name, url]) => (
                  <li key={name}>
                    <span className="text-fg">{NETWORK[name] ?? name}</span>: {url}
                  </li>
                ))}
              </ul>
            )}
          </Row>
        </dl>
      </Card>
      <Card>
        <h3 className="font-semibold text-fg">Features and maintenance</h3>
        <dl className="mt-2 divide-y divide-line">
          <Row label="Comments">
            {onOff(g.features.comments)}
            {g.features.comments && `; new reader comments ${g.discussion.requireApproval ? "need approval" : "appear at once"}`}
          </Row>
          <Row label="Reader sign-up">{onOff(g.features.registration)}</Row>
          <Row label="Contact form">{onOff(g.features.contactForm)}</Row>
          <Row label="Public user manual">{onOff(g.features.publicGuide)}</Row>
          <Row label="Maintenance mode">{g.maintenance.enabled ? <strong className="text-fg">On: public pages answer 503</strong> : "Off"}</Row>
        </dl>
      </Card>
    </section>
  );
}

/** The Appearance editor's sections, each a link: the design is one draft, edited with a preview and published together. */
const APPEARANCE_SECTIONS: { id: string; label: string; description: string }[] = [
  { id: "branding", label: "Branding", description: "Logo, favicon and the default share image." },
  { id: "header", label: "Header", description: "Presets, layout, background, controls and the announcement bar." },
  { id: "navigation", label: "Navigation", description: "The header and footer menus." },
  { id: "footer", label: "Footer", description: "The layout and content at the foot of every page." },
  { id: "theme", label: "Typography & colours", description: "Typography, light and dark theme colours, layout and shape." },
  { id: "homepage", label: "Homepage", description: "The sections of the home page and their order." },
  { id: "blog", label: "Blog & articles", description: "Listings, article pages, the table of contents, related articles and sharing." },
  { id: "media", label: "Media", description: "How images in articles are shown, and the library's storage status." },
  { id: "seo", label: "SEO & integrations", description: "Titles and descriptions, and the status of the integrations." },
  { id: "hireMe", label: "Hire me", description: "The Hire me page and availability, booking and pricing, and its call to action in articles." },
  { id: "advanced", label: "Advanced", description: "Custom CSS." },
  { id: "history", label: "Revision history", description: "Every published version, with restore, import and export." },
];

export function AppearanceSection() {
  return (
    <section aria-labelledby="appearance-title" className="space-y-4">
      <SectionHeading
        id="appearance-title"
        title="Appearance"
        description="The look of the site is one draft in the Appearance editor: change any part with a live preview on a phone, tablet or desktop, then publish it all at once. Nothing changes for readers before Publish."
        aside={
          <Link href="/admin/appearance" className={buttonClass("primary", "sm")}>
            Open Appearance
          </Link>
        }
      />
      <ul className="grid gap-3 sm:grid-cols-2">
        {APPEARANCE_SECTIONS.map((s) => (
          <li key={s.id} className="min-w-0">
            <Link href={APPEARANCE(s.id)} className="block h-full rounded-xl border border-line bg-surface p-4 shadow-sm transition-colors hover:border-line-strong hover:bg-surface-muted">
              <span className="font-medium text-fg">{s.label}</span>
              <span className="mt-1 block text-sm text-fg-muted">{s.description}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
