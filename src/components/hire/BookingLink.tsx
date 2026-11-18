"use client";

import type { MouseEvent, ReactNode } from "react";
import { trackLead } from "./track";

type CalFn = ((...args: unknown[]) => void) & { q?: unknown[][]; loaded?: boolean; ns?: Record<string, unknown> };
type Win = typeof globalThis & { Cal?: CalFn };

const LOAD_TIMEOUT_MS = 8000;
const loads = new Map<string, Promise<CalFn>>();

/**
 * Cal.com's embed loader, loaded on the first click only (nothing third-party for readers who never book). Same
 * queueing stub as Cal.com's official snippet: calls made before embed.js arrives are queued and replayed by it.
 * Rejects when the script is blocked or slow, so the click can fall back to the booking page.
 */
function loadCal(origin: string, onBooked: () => void): Promise<CalFn> {
  const existing = loads.get(origin);
  if (existing) return existing;
  const w = globalThis as Win;
  const p = new Promise<CalFn>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `${origin}/embed/embed.js`;
    script.async = true;
    const timer = setTimeout(() => reject(new Error("Cal.com embed timed out")), LOAD_TIMEOUT_MS);
    script.onload = () => {
      clearTimeout(timer);
      resolve(w.Cal!);
    };
    script.onerror = () => {
      clearTimeout(timer);
      reject(new Error("Cal.com embed blocked"));
    };
    const cal: CalFn = Object.assign((...args: unknown[]) => void cal.q!.push(args), { q: [] as unknown[][], ns: {}, loaded: true });
    w.Cal ??= cal;
    document.head.appendChild(script);
    w.Cal("init", { origin });
    // Once per load, so a booking is counted once however often the pop-up was opened.
    w.Cal("on", { action: "bookingSuccessfulV2", callback: onBooked });
  });
  p.catch(() => loads.delete(origin)); // a later click may retry
  loads.set(origin, p);
  return p;
}

/**
 * A booking button. With `embed` (a Cal.com link and the pop-up switched on in Admin → Appearance → Hire me), it opens
 * Cal.com's scheduler over the page; otherwise, or if Cal.com's script cannot load, it is a plain link to the booking
 * page. Records GA4 lead events (click, and a completed booking) without personal data.
 */
export function BookingLink({ href, kind, embed, className, children }: { href: string; kind: string; embed?: { origin: string; calLink: string } | null; className?: string; children: ReactNode }) {
  function open(e: MouseEvent<HTMLAnchorElement>) {
    trackLead("booking_clicked", kind);
    if (!embed || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // new-tab clicks keep the link
    e.preventDefault();
    const theme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    void loadCal(embed.origin, () => trackLead("booking_completed", "cal"))
      .then((cal) => cal("modal", { calLink: embed.calLink, calOrigin: embed.origin, config: { layout: "month_view", theme } }))
      .catch(() => {
        // Blocked by an extension or offline: go to the booking page instead (a new tab here would be blocked).
        globalThis.location.assign(href);
      });
  }
  return (
    <a href={href} target="_blank" rel="noopener" className={className} onClick={open}>
      {children}
    </a>
  );
}
