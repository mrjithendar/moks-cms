import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Container } from "@/components/Container";
import { JsonLd } from "@/components/JsonLd";
import { ArrowRight, CheckBadge, GitHubIcon, LinkedInIcon } from "@/components/icons";
import { BookingLink } from "@/components/hire/BookingLink";
import { EnquiryForm } from "@/components/hire/EnquiryForm";
import { PaidCall } from "@/components/hire/PaidCall";
import { absoluteUrl, site } from "@/config/site";
import { CERTIFICATIONS, EXPERIENCE, HIGHLIGHTS, PROCESS, PROFILE, SELECTED_WORK, SKILLS } from "@/config/hire-me-profile";
import { calEmbedTarget } from "@/lib/calcom";
import { AVAILABILITY_LABEL, activeOffers, bookingUrlFor, paidCallOpen, priceLabel } from "@/lib/hire-me";
import { shareImages } from "@/lib/seo/metadata";
import { getSiteConfig } from "@/lib/site-config";
import { turnstileKeys } from "@/lib/turnstile";

// ISR (lib/page-cache.ts): rendered once, served from the page cache, re-rendered after 300 s (PAGE_REVALIDATE_SECONDS)
// and cleared on every replica when content or settings change (offers, prices and availability are settings).
export const revalidate = 300;

const TITLE = "Hire me: AI platform, Kubernetes and cloud engineering";
const DESCRIPTION =
  "Consulting, freelance projects, speaking and mentoring from Jithendar Dharmapuri: AI gateways, MCP and agents, Amazon EKS, Terraform and observability.";

export async function generateMetadata(): Promise<Metadata> {
  const { config } = await getSiteConfig();
  if (!config.hireMe.enabled) return { title: "Not found", robots: { index: false } };
  // An openGraph object here replaces the site's, image included: add the default share image back explicitly.
  const images = shareImages();
  return {
    title: TITLE,
    description: DESCRIPTION,
    alternates: { canonical: "/hire-me" },
    openGraph: { title: TITLE, description: DESCRIPTION, url: "/hire-me", type: "profile", siteName: site.name, locale: site.locale, images: images.og },
    twitter: { ...images.twitter, title: TITLE, description: DESCRIPTION },
  };
}

const DOT: Record<string, string> = { available: "bg-emerald-500", limited: "bg-amber-500", unavailable: "bg-slate-400" };
const btn = "inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2";
const primary = `${btn} bg-accent text-on-accent hover:opacity-90`;
const secondary = `${btn} border border-line bg-surface text-fg hover:bg-surface-muted`;

export default async function HireMePage() {
  const { config } = await getSiteConfig();
  const h = config.hireMe;
  if (!h.enabled) notFound();
  const offers = activeOffers(h);
  const booking = bookingUrlFor(h);
  // Cal.com links open in Cal.com's pop-up scheduler (when switched on); other links open in a new tab.
  const embedFor = (url: string) => (h.embedBooking && url ? calEmbedTarget(url, h.calOrigin) : null);
  const { siteKey } = await turnstileKeys();
  // Paid calls: rendered only while switched on; the component asks the server for the visitor's price on load.
  const paid = paidCallOpen(h);
  const ld = {
    "@context": "https://schema.org" as const,
    "@type": "ProfilePage",
    url: absoluteUrl("/hire-me"),
    mainEntity: {
      "@type": "Person",
      "@id": `${absoluteUrl("/authors/jithendar-dharmapuri")}#person`,
      name: PROFILE.name,
      jobTitle: PROFILE.role,
      address: { "@type": "PostalAddress", addressLocality: PROFILE.location },
      sameAs: [PROFILE.linkedin, PROFILE.github],
      knowsAbout: SKILLS.flatMap((s) => s.items).slice(0, 20),
      hasCredential: CERTIFICATIONS.map((c) => ({ "@type": "EducationalOccupationalCredential", name: c.name })),
      makesOffer: offers.map(({ offer }) => ({ "@type": "Offer", itemOffered: { "@type": "Service", name: offer.title, description: offer.summary } })),
    },
  };

  return (
    <>
      <JsonLd data={ld} />
      <section className="border-b border-line bg-surface-muted py-section">
        <Container>
          <p className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-sm font-medium text-fg">
            <span className={`h-2 w-2 rounded-full ${DOT[h.availability]}`} aria-hidden="true" />
            {AVAILABILITY_LABEL[h.availability]}
          </p>
          <h1 className="mt-5 max-w-4xl text-display font-semibold tracking-tight text-fg">{h.headline}</h1>
          {h.intro && <p className="mt-5 max-w-3xl text-lg text-fg-muted">{h.intro}</p>}
          {h.availabilityNote && <p className="mt-3 max-w-3xl text-fg-muted">{h.availabilityNote}</p>}
          <div className="mt-8 flex flex-wrap gap-3">
            {booking && h.availability !== "unavailable" && (
              <BookingLink href={booking} kind="intro" embed={embedFor(booking)} className={primary}>Book an intro call <ArrowRight className="h-4 w-4" /></BookingLink>
            )}
            {paid && <a href="#paid-call" className={secondary}>Book a paid call</a>}
            <a href="#enquiry" className={booking ? secondary : primary}>Send an enquiry</a>
          </div>
          <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm text-fg-muted">
            <li><strong className="text-fg">{PROFILE.yearsExperience} years</strong> in cloud and platform engineering</li>
            {CERTIFICATIONS.map((c) => <li key={c.name} className="inline-flex items-center gap-1.5"><CheckBadge className="h-4 w-4 text-accent-text" />{c.name}</li>)}
            <li>Based in {PROFILE.location}, working remotely</li>
          </ul>
        </Container>
      </section>

      {paid && <PaidCall title={h.paidCall.title} summary={h.paidCall.summary} siteKey={siteKey} merchant={site.name} />}

      <section aria-labelledby="offers" className="py-section">
        <Container>
          <h2 id="offers" className="text-heading font-semibold text-fg">How I can help</h2>
          <ul className="mt-6 grid grid-cols-[minmax(0,1fr)] gap-5 sm:grid-cols-2">
            {offers.map(({ key, offer }) => {
              const link = bookingUrlFor(h, key);
              return (
                <li key={key} className="flex flex-col rounded-2xl border border-line bg-surface p-6">
                  <h3 className="text-lg font-semibold text-fg">{offer.title}</h3>
                  <p className="mt-2 flex-1 text-fg-muted">{offer.summary}</p>
                  <p className="mt-4 text-sm font-semibold text-fg">{priceLabel(offer.price, offer.unit, h.currency)}</p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {link && h.availability !== "unavailable" && <BookingLink href={link} kind={key} embed={embedFor(link)} className={primary}>Book</BookingLink>}
                    <a href={`#enquiry-${key}`} className={link ? secondary : primary}>Enquire</a>
                  </div>
                </li>
              );
            })}
          </ul>
        </Container>
      </section>

      <section aria-labelledby="built" className="border-y border-line bg-surface-muted py-section">
        <Container>
          <h2 id="built" className="text-heading font-semibold text-fg">What I&apos;ve built in production</h2>
          <p className="mt-2 text-fg-muted">As {PROFILE.role} at S&amp;P Global, and before that across AWS, Kubernetes and data platforms.</p>
          <ul className="mt-6 grid grid-cols-[minmax(0,1fr)] gap-x-8 gap-y-3 md:grid-cols-2">
            {HIGHLIGHTS.map((t) => (
              <li key={t} className="flex gap-3 text-fg"><CheckBadge className="mt-0.5 h-5 w-5 shrink-0 text-accent-text" />{t}</li>
            ))}
          </ul>
        </Container>
      </section>

      <section aria-labelledby="work" className="py-section">
        <Container>
          <h2 id="work" className="text-heading font-semibold text-fg">Selected work on this site</h2>
          <ul className="mt-6 grid grid-cols-[minmax(0,1fr)] gap-5 sm:grid-cols-2">
            {SELECTED_WORK.map((w) => (
              <li key={w.href}>
                <Link href={w.href} className="block h-full rounded-2xl border border-line bg-surface p-6 hover:border-accent">
                  <span className="font-semibold text-fg">{w.title}</span>
                  <span className="mt-2 block text-fg-muted">{w.what}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Container>
      </section>

      <section aria-labelledby="skills" className="border-y border-line bg-surface-muted py-section">
        <Container>
          <h2 id="skills" className="text-heading font-semibold text-fg">Skills</h2>
          <div className="mt-6 grid grid-cols-[minmax(0,1fr)] gap-6 md:grid-cols-2">
            {SKILLS.map((s) => (
              <div key={s.group}>
                <h3 className="font-semibold text-fg">{s.group}</h3>
                <ul className="mt-3 flex flex-wrap gap-2">
                  {s.items.map((i) => <li key={i} className="rounded-full border border-line bg-surface px-3 py-1 text-sm text-fg">{i}</li>)}
                </ul>
              </div>
            ))}
          </div>
        </Container>
      </section>

      <section aria-labelledby="experience" className="py-section">
        <Container narrow>
          <h2 id="experience" className="text-heading font-semibold text-fg">Experience</h2>
          <ol className="mt-6 space-y-4 border-l border-line pl-6">
            {EXPERIENCE.map((e) => (
              <li key={`${e.org}-${e.from}`}>
                <p className="font-semibold text-fg">{e.role} · {e.org}</p>
                <p className="text-sm text-fg-subtle">{e.place} · {e.from} – {e.to}</p>
              </li>
            ))}
          </ol>
          <p className="mt-6 flex flex-wrap gap-4 text-sm">
            <a href={PROFILE.linkedin} rel="noopener me" className="inline-flex items-center gap-1.5 font-semibold text-accent-text hover:underline"><LinkedInIcon className="h-4 w-4" /> LinkedIn</a>
            <a href={PROFILE.github} rel="noopener me" className="inline-flex items-center gap-1.5 font-semibold text-accent-text hover:underline"><GitHubIcon className="h-4 w-4" /> GitHub</a>
            <Link href="/about" className="inline-flex items-center gap-1.5 font-semibold text-accent-text hover:underline">About me <ArrowRight className="h-4 w-4" /></Link>
          </p>
        </Container>
      </section>

      <section aria-labelledby="process" className="border-y border-line bg-surface-muted py-section">
        <Container>
          <h2 id="process" className="text-heading font-semibold text-fg">How it works</h2>
          <ol className="mt-6 grid grid-cols-[minmax(0,1fr)] gap-5 md:grid-cols-3">
            {PROCESS.map((p, i) => (
              <li key={p.step} className="rounded-2xl border border-line bg-surface p-6">
                <p className="text-sm font-semibold text-accent-text">Step {i + 1}</p>
                <h3 className="mt-1 font-semibold text-fg">{p.step}</h3>
                <p className="mt-2 text-fg-muted">{p.text}</p>
              </li>
            ))}
          </ol>
        </Container>
      </section>

      <section id="enquiry" aria-labelledby="enquiry-title" className="scroll-mt-24 py-section">
        {/* Targets of the offers' "Enquire" links: the form picks the kind from the hash (no reload, page stays cached). */}
        {offers.map(({ key }) => <span key={key} id={`enquiry-${key}`} className="block scroll-mt-24" aria-hidden="true" />)}
        <Container narrow>
          <h2 id="enquiry-title" className="text-heading font-semibold text-fg">Send an enquiry</h2>
          <p className="mt-2 text-fg-muted">Tell me what you&apos;re working on. {booking && h.availability !== "unavailable" ? "Prefer to talk? Book an intro call instead." : ""}</p>
          <div className="mt-6 rounded-2xl border border-line bg-surface p-4 shadow-sm sm:p-8">
            <EnquiryForm siteKey={siteKey} responseTime={h.responseTime} />
          </div>
        </Container>
      </section>
    </>
  );
}
