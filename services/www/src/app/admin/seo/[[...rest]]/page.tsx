import { redirect } from "next/navigation";
import { seoRedirectTarget } from "@/lib/seo-intel/old-urls";

/**
 * The SEO area is part of the CMS now (docs/seo/DECISIONS.md D-86): its pages moved out of /admin/seo. Old links
 * (bookmarks, digest and alert emails sent before the move) land on the new page.
 */
export default async function OldSeoUrl({ params, searchParams }: { params: Promise<{ rest?: string[] }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ rest }, sp] = await Promise.all([params, searchParams]);
  const q = new URLSearchParams(Object.entries(sp).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : v === undefined ? [] : [[k, v]])));
  redirect(`${seoRedirectTarget(rest)}${q.size ? `?${q}` : ""}`);
}
