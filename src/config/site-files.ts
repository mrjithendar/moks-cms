/**
 * The site's own files, read at run time: site.json and config/*.json in the site folder. One moks-cms image serves any
 * site; the site's files arrive next to its content (jithendar.com: its content image, which the Deployment's init
 * container copies to /app/site). They are never compiled into the app.
 *
 *   SITE_CONFIG_DIR   the folder holding site.json and config/ (default: site/ in the working directory, which
 *                     `npm run site` fills for development, tests and builds, and the image ships with the test
 *                     fixture site's copy, so a bare image still starts)
 *
 * Server code reads the folder. Browser code cannot, so the root layout writes site.json into the page
 * (siteFileScript) and the browser reads that copy: site.json holds only public facts (name, links, AdSense ID).
 */

/** site.json. Unknown keys are kept (e.g. `deploy`, which only the site's own CI reads). */
export type SiteFile = {
  host: string;
  name: string;
  publicationName: string;
  tagline: string;
  description: string;
  language: string;
  locale: string;
  timeZone: string;
  primaryAuthor: string;
  editorBio: string;
  social: { github: string; x: string; linkedin: string; youtube: string; mastodon: string };
  adsenseClientId: string;
  aiCrawlers?: { search?: string; training?: string };
  [key: string]: unknown;
};

const GLOBAL = "__MOKS_SITE__";

type NodeFs = { readFileSync(path: string, encoding: "utf8"): string; existsSync(path: string): boolean };

/** node:fs on the server (Node), undefined in the browser. Not an import, so no bundler tries to resolve it. */
function nodeFs(): NodeFs | undefined {
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  return typeof proc?.getBuiltinModule === "function" ? (proc.getBuiltinModule("node:fs") as NodeFs) : undefined;
}

/** The folder with site.json and config/ (server only). */
export function siteConfigDir(): string {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined>; cwd?: () => string } }).process;
  const dir = env?.env?.SITE_CONFIG_DIR || `${env?.cwd?.() ?? "."}/site`;
  return dir.replace(/\/+$/, "");
}

/** A JSON file of the site folder (server only). Missing: `fallback` if given, otherwise an error naming the file. */
export function readSiteJson<T>(relative: string, fallback?: T): T {
  const fs = nodeFs();
  if (!fs) throw new Error(`${relative}: site files are read on the server only`);
  const file = `${siteConfigDir()}/${relative}`;
  if (!fs.existsSync(file)) {
    if (fallback !== undefined) return fallback;
    throw new Error(`${file} not found: set SITE_CONFIG_DIR or run \`npm run site\` (scripts/use-site.mjs)`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

const BLANK: SiteFile = {
  host: "localhost",
  name: "",
  publicationName: "",
  tagline: "",
  description: "",
  language: "en",
  locale: "en_US",
  timeZone: "UTC",
  primaryAuthor: "",
  editorBio: "",
  social: { github: "", x: "", linkedin: "", youtube: "", mastodon: "" },
  adsenseClientId: "",
};

/** site.json: from the site folder on the server, from the copy the root layout wrote into the page in the browser. */
export function loadSiteFile(): SiteFile {
  if (nodeFs()) return { ...BLANK, ...readSiteJson<SiteFile>("site.json") };
  const copy = (globalThis as Record<string, unknown>)[GLOBAL] as SiteFile | undefined;
  return { ...BLANK, ...copy };
}

/** The inline script for the root layout's <head>: puts site.json where loadSiteFile() finds it in the browser. */
export function siteFileScript(file: SiteFile): string {
  // JSON in a <script>: escape "<" so no value can close the tag.
  const visible: Record<string, unknown> = { ...file };
  delete visible.deploy; // for the site's CI, not for readers
  return `globalThis.${GLOBAL}=${JSON.stringify(visible).replace(/</g, "\\u003c")};`;
}
