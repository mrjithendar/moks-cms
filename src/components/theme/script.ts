/**
 * localStorage key for the reader's explicit theme choice ("light" | "dark"; absent = the site default). Not plain
 * "theme": the admin tools share this origin, and Argo CD (/argocd) reads "theme" with JSON.parse when it starts, so
 * the bare light/dark this site kept there left Argo CD a blank page.
 */
export const THEME_KEY = "site-theme";

/** Where the choice was kept before THEME_KEY. The head script moves a bare light/dark from there (Argo CD's own value
 * is JSON, "\"dark\"", and stays). */
export const LEGACY_THEME_KEY = "theme";

/**
 * Runs inline in <head> before first paint, so an explicit choice never flashes the other theme.
 * Without a stored choice the site default applies: "system" follows prefers-color-scheme in CSS (also
 * without JavaScript); "light"/"dark" (set in Admin → Appearance) are applied here.
 */
export function themeScript(defaultMode: "system" | "light" | "dark"): string {
  const fallback = defaultMode === "system" ? "" : defaultMode;
  return (
    `(function(){try{var s=localStorage,t=s.getItem("${THEME_KEY}"),o=s.getItem("${LEGACY_THEME_KEY}");` +
    `if(o==="light"||o==="dark"){if(t===null){t=o;s.setItem("${THEME_KEY}",o);}s.removeItem("${LEGACY_THEME_KEY}");}` +
    `if(t!=="light"&&t!=="dark")t="${fallback}";if(t)document.documentElement.dataset.theme=t;}catch(e){}})();`
  );
}
