import type { MetadataRoute } from "next";
import { getSettings } from "@/lib/settings";

// ISR like the sitemap: re-rendered after 300 s and cleared when settings change (the site name lives there).
export const revalidate = 300;

/**
 * The web app manifest: name and icons for "Add to Home Screen" and Android's tab and task-switcher icons. The PNGs
 * are rendered from src/app/icon.svg (public/icon-192.png, icon-512.png); a favicon uploaded in Admin → Appearance →
 * Branding replaces the tab icon, not these.
 */
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const settings = await getSettings();
  return {
    name: settings.siteName,
    short_name: settings.siteName,
    description: settings.description,
    start_url: "/",
    display: "browser",
    background_color: "#ffffff",
    theme_color: "#18181b",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
    ],
  };
}
