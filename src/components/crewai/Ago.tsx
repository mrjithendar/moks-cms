"use client";

import { useSyncExternalStore } from "react";
import { formatLocal } from "@/components/LocalTime";

const subscribe = (tick: () => void) => {
  const t = window.setInterval(tick, 30_000);
  return () => window.clearInterval(t);
};

export function relative(iso: string, now: number): string {
  const s = Math.round((now - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(s)) return iso;
  if (s < -45) {
    // A time to come (a schedule's next run): "in 12 min", "in 3 h", "in 2 days".
    const fm = Math.round(-s / 60);
    if (fm < 60) return `in ${fm} min`;
    const fh = Math.round(fm / 60);
    if (fh < 24) return `in ${fh} h`;
    const fd = Math.round(fh / 24);
    return fd < 30 ? `in ${fd} day${fd === 1 ? "" : "s"}` : formatLocal(iso, "date");
  }
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d} day${d === 1 ? "" : "s"} ago` : formatLocal(iso, "date");
}

/**
 * "4 min ago", refreshed every 30 s, with the full local time as its tooltip. The server renders the UTC date (it does
 * not know the viewer's clock or zone); the browser switches to the relative time after hydration.
 */
export function Ago({ iso }: { iso: string }) {
  const now = useSyncExternalStore(subscribe, () => Math.floor(Date.now() / 30_000) * 30_000, () => 0);
  return (
    <time dateTime={iso} title={now ? formatLocal(iso) : undefined} className="whitespace-nowrap">
      {now ? relative(iso, now) : iso.slice(0, 16).replace("T", " ") + " UTC"}
    </time>
  );
}
