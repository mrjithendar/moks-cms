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

// --- Paid calls (Razorpay) ------------------------------------------------------------------------------------------

export type PaidCall = HireMe["paidCall"];
/** Visitors in India pay in INR; everyone else pays in USD. */
export const PAY_CURRENCIES = ["INR", "USD"] as const;
export type PayCurrency = (typeof PAY_CURRENCIES)[number];

/** From Cloudflare's CF-IPCountry header (two letters; "XX"/"T1" or missing when unknown → USD). */
export function payCurrencyFor(country: string | null | undefined): PayCurrency {
  return country?.trim().toUpperCase() === "IN" ? "INR" : "USD";
}

/** Price per minute in the smallest unit (paise or cents); integer, so totals never drift. */
export function minorPerMinute(pc: PaidCall, currency: PayCurrency): number {
  return Math.round((currency === "INR" ? pc.ratePerMinuteInr : pc.ratePerMinuteUsd) * 100);
}

/** The lengths a visitor can choose: min, min+step, … up to max (at most 100 options). */
export function callDurations(pc: PaidCall): number[] {
  const out: number[] = [];
  for (let m = pc.minMinutes; m <= pc.maxMinutes && out.length < 100; m += pc.stepMinutes) out.push(m);
  return out;
}

/** Total in the smallest unit for `minutes`, or null when that length is not on offer. */
export function callAmountMinor(pc: PaidCall, currency: PayCurrency, minutes: number): number | null {
  if (!Number.isInteger(minutes) || !callDurations(pc).includes(minutes)) return null;
  const per = minorPerMinute(pc, currency);
  return per > 0 ? per * minutes : null;
}

/** "₹1,500" / "$25" / "$2.50" from an amount in the smallest unit. */
export function moneyLabel(minor: number, currency: PayCurrency): string {
  const whole = minor % 100 === 0;
  return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", { style: "currency", currency, minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 }).format(minor / 100);
}

/** Whether the paid-call card is shown (the Razorpay keys are checked separately, on the server). */
export function paidCallOpen(h: HireMe): boolean {
  const pc = h.paidCall;
  return h.enabled && h.availability !== "unavailable" && pc.enabled && pc.ratePerMinuteInr > 0 && pc.ratePerMinuteUsd > 0 && callDurations(pc).length > 0;
}

/** Where the payer books after paying: the paid call's link, else the general one. */
export function paidCallBookingUrl(h: HireMe): string {
  return h.paidCall.bookingUrl || h.bookingUrl || "";
}

/**
 * The booking link with the paid length and the payer's details filled in. Cal.com reads `duration` (event types with
 * several lengths), `name`, `email` and `metadata[...]` from the query; other booking sites ignore them.
 */
export function bookingLinkAfterPayment(url: string, p: { minutes: number; name: string; email: string; paymentId: string }): string {
  try {
    const u = new URL(url);
    u.searchParams.set("duration", String(p.minutes));
    u.searchParams.set("name", p.name);
    u.searchParams.set("email", p.email);
    u.searchParams.set("metadata[razorpayPaymentId]", p.paymentId);
    return u.toString();
  } catch {
    return url;
  }
}
