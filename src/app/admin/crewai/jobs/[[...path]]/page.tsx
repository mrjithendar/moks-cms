import { redirect } from "next/navigation";
import { crewJobsTarget } from "@/lib/news/old-addresses";

export const dynamic = "force-dynamic";

/**
 * AI & SEO had crew jobs from 2026-11-21 to 2026-11-23; since then it has flows and crews only. Every old jobs address
 * sends the browser to where that page lives now (lib/news/old-addresses.ts).
 */
export default async function OldCrewJobsAddress({ params, searchParams }: { params: Promise<{ path?: string[] }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ path = [] }, sp] = await Promise.all([params, searchParams]);
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) for (const one of Array.isArray(v) ? v : v === undefined ? [] : [v]) query.append(k, one);
  redirect(crewJobsTarget(path, query));
}
