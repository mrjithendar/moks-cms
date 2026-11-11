import type { MetadataRoute } from "next";
import { buildSitemap } from "@/lib/seo/sitemap";

// ISR (lib/page-cache.ts): rendered once, served from the page cache, re-rendered after 300 s (PAGE_REVALIDATE_SECONDS)
// and cleared on every replica when content or settings change.
export const revalidate = 300;

export default function sitemap(): Promise<MetadataRoute.Sitemap> {
  return buildSitemap();
}
