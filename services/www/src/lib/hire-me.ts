import type { HireOfferKey, SiteConfig } from "./site-config/schema";
import { HIRE_OFFERS } from "./site-config/schema";

/**
 * Hire me: shared by /hire-me, the article call to action and the enquiry form. The offers, prices, booking links and
 * availability live in the site configuration (Admin → Appearance → Hire me), so they follow its draft, preview,
 * publish and history, and a change clears the page cache like any other setting.
 */
export type HireMe = SiteConfig["hireMe"];

/** What an enquiry is about: the four offers plus a catch-all. Stored in contact_message.kind. */
export const ENQUIRY_KINDS = [...HIRE_OFFERS, "other"] as const;
export type EnquiryKind = (typeof ENQUIRY_KINDS)[number];

export const ENQUIRY_LABELS: Record<EnquiryKind, string> = {
  consulting: "Consulting",
  freelance: "Freelance project",
  speaking: "Speaking or workshop",
  mentoring: "Mentoring",
  other: "Something else",
};

export const BUDGETS = ["Not sure yet", "Under 1,000", "1,000–5,000", "5,000–20,000", "Over 20,000"] as const;
export const TIMELINES = ["As soon as possible", "Within a month", "In 1–3 months", "Later / exploring"] as const;

const UNIT_LABEL: Record<HireMe["offers"][HireOfferKey]["unit"], string> = {
  hour: "per hour",
  day: "per day",
  session: "per session",
  project: "per project",
  talk: "per talk",
  month: "per month",
};

/** "From SGD 150 per hour", or "On request" while the price is 0 (the default: prices are set in the admin). */
export function priceLabel(price: number, unit: HireMe["offers"][HireOfferKey]["unit"], currency: HireMe["currency"]): string {
  if (price <= 0) return "On request";
  const amount = new Intl.NumberFormat("en", { style: "currency", currency, maximumFractionDigits: 0 }).format(price);
  return `From ${amount} ${UNIT_LABEL[unit]}`;
}

/** The offers that are switched on, in display order. */
export function activeOffers(h: HireMe): { key: HireOfferKey; offer: HireMe["offers"][HireOfferKey] }[] {
  return HIRE_OFFERS.filter((k) => h.offers[k].enabled).map((key) => ({ key, offer: h.offers[key] }));
}

/** Where "Book" goes for an offer: its own booking page, else the general one, else nothing (the form is used). */
export function bookingUrlFor(h: HireMe, key?: HireOfferKey): string {
  return (key && h.offers[key].bookingUrl) || h.bookingUrl || "";
}

/** Calls to action (header, articles) only while the page is on and work is being taken. */
export function hireCtaVisible(h: HireMe): boolean {
  return h.enabled && h.availability !== "unavailable";
}

export const AVAILABILITY_LABEL: Record<HireMe["availability"], string> = {
  available: "Available for new work",
  limited: "Limited availability",
  unavailable: "Not taking new work right now",
};
