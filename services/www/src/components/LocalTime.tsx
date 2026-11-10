"use client";

import { useSyncExternalStore } from "react";

type Style = "datetime" | "date" | "time";

const OPTS: Record<Style, Intl.DateTimeFormatOptions> = {
  datetime: { dateStyle: "medium", timeStyle: "short" },
  date: { dateStyle: "medium" },
  time: { timeStyle: "short" },
};

/** Format in the viewer's time zone (or `timeZone` when given), with the zone's short name for date-times and times. */
export function formatLocal(iso: string, style: Style = "datetime", timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const text = new Intl.DateTimeFormat("en-GB", { ...OPTS[style], ...(timeZone ? { timeZone } : {}) }).format(d);
  if (style === "date") return text;
  const zone = new Intl.DateTimeFormat("en-GB", { timeZoneName: "short", ...(timeZone ? { timeZone } : {}) }).formatToParts(d).find((p) => p.type === "timeZoneName")?.value;
  return zone ? `${text} ${zone}` : text;
}

const subscribe = () => () => {};

/**
 * A timestamp in the VIEWER's local time zone (owner decision 2026-11-10: "all timestamps shown in local time").
 * Server components can't know the browser's zone, so the server renders UTC and the browser re-renders it in local
 * time straight after hydration (useSyncExternalStore: server snapshot false → client true). The ISO value is kept in
 * <time dateTime> and the tooltip shows UTC for cross-checking logs.
 */
export function LocalTime({ iso, style = "datetime", fallback = "—" }: { iso: string | Date | null | undefined; style?: Style; fallback?: string }) {
  const onClient = useSyncExternalStore(subscribe, () => true, () => false);
  if (!iso) return <>{fallback}</>;
  const value = iso instanceof Date ? iso.toISOString() : iso;
  return (
    <time dateTime={value} title={formatLocal(value, "datetime", "UTC")}>
      {formatLocal(value, style, onClient ? undefined : "UTC")}
    </time>
  );
}
