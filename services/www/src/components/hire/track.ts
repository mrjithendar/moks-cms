"use client";

type Gtag = (...args: unknown[]) => void;

/**
 * Lead events for Google Analytics (GA4 "generate_lead"), through the site's consent-aware gtag only: nothing is sent
 * when analytics is not configured or consent was refused. No personal data: the kind of enquiry and where it
 * came from (the path), never names or emails.
 */
export function trackLead(action: "enquiry_submitted" | "booking_clicked" | "booking_completed", kind: string, source?: string) {
  const gtag = (globalThis as { gtag?: Gtag }).gtag;
  gtag?.("event", "generate_lead", { lead_action: action, lead_kind: kind, lead_source: source ?? globalThis.location?.pathname ?? "" });
}
