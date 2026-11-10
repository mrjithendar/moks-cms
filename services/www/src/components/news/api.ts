"use client";

import { createElement, type ReactNode } from "react";
import { LocalTime } from "@/components/LocalTime";

/** JSON call to /api/admin/news/* (or the SEO review API). Throws Error(message incl. the server's issues). */
export async function api<T = Record<string, unknown>>(url: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" = "GET", body?: unknown): Promise<T> {
  const res = await fetch(url, { method, headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as { error?: string; issues?: string[]; reference?: string };
  if (!res.ok) throw new Error([data.error ?? `HTTP ${res.status}`, ...(data.issues ?? [])].join(" · ") + (data.reference ? ` (ref ${data.reference})` : ""));
  return data as T;
}

export const usd = (v: unknown) => `$${Number(v ?? 0).toFixed(Number(v ?? 0) < 1 ? 3 : 2)}`;
/** A timestamp in the viewer's local time zone (LocalTime). */
export const when = (iso: unknown): ReactNode => (iso ? createElement(LocalTime, { iso: String(iso) }) : "—");
export const ago = (iso: unknown) => {
  if (!iso) return "never";
  const m = Math.round((Date.now() - Date.parse(String(iso))) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
