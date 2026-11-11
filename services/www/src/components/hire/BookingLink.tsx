"use client";

import type { ReactNode } from "react";
import { trackLead } from "./track";

/** An external booking link (Cal.com) that records a GA4 lead event when clicked. A plain link: no embedded widget. */
export function BookingLink({ href, kind, className, children }: { href: string; kind: string; className?: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener" className={className} onClick={() => trackLead("booking_clicked", kind)}>
      {children}
    </a>
  );
}
