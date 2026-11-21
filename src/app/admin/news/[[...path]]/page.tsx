import { redirect } from "next/navigation";
import { newsroomTarget } from "@/lib/news/old-addresses";

export const dynamic = "force-dynamic";

/** Every address of the old Newsroom sends the browser to where that page lives now (lib/news/old-addresses.ts). */
export default async function OldNewsroomAddress({ params, searchParams }: { params: Promise<{ path?: string[] }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ path = [] }, sp] = await Promise.all([params, searchParams]);
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) for (const one of Array.isArray(v) ? v : v === undefined ? [] : [v]) query.append(k, one);
  redirect(newsroomTarget(path, query));
}
