#!/usr/bin/env node
/**
 * Choose which website this app serves. A site is a folder with this layout (a site's own repository, like
 * moks-tech/jithendar.com, or sites/<domain>/ in this repository):
 *
 *   site.json        identity (host, name, author, social links, AdSense ID)
 *   config/          redirects.json, gone.json (410 URLs), hire-me-profile.json
 *   content/         articles, pages, authors, Python practice
 *   public/images/   images the articles use (served as /images/…)
 *   docs/            sources of the articles' figures and checks (never shipped)
 *
 * Which folder, first match wins:
 *
 *   SITE_DIR=<path>   any folder (absolute, or relative to the current directory): a site repository checked out
 *                     next to this one
 *   SITE=<domain>     sites/<domain>/ at the root of this repository
 *   (neither)         tests/fixtures/site, the small site the tests and local development run against
 *
 * The app reads site/, content/ and public/images/ in the app folder at run time (/app/site, /app/content and
 * /app/public/images in the container, where a site's content image copies them; src/config/site-files.ts). This
 * script fills those three paths from the chosen folder for development, tests and builds:
 *
 *   site/            always a copy of site.json and config/
 *   content/         a symlink for development (edit files in the site folder as usual), or with --copy a real
 *   public/images/   copy, for CI and Docker builds (COPY and output tracing do not follow links out of the folder)
 *
 *   npm run site      SITE_DIR=../jithendar.com npm run site      SITE=example.com npm run site -- --copy
 *
 * dev, preview, build, typecheck and test run it first (package.json "pre" scripts). A plain run keeps copies of
 * content/ and public/images/ that are already there for the same site. It never replaces a real folder it did not
 * create.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The folder used when neither SITE_DIR nor SITE is set, relative to the app folder. */
export const DEFAULT_SITE_DIR = path.join("tests", "fixtures", "site");
const MARKER = ".site-copy";

/** What this script manages in the app folder, and where it comes from in sites/<domain>/. */
const ENTRIES = [
  { at: "site", from: ["site.json", "config"], always: "copy" },
  { at: "content", from: "content" },
  { at: path.join("public", "images"), from: path.join("public", "images") },
];

function lstat(p) {
  try {
    return fs.lstatSync(p);
  } catch {
    return undefined;
  }
}

function copyOf(p) {
  try {
    return fs.readFileSync(path.join(p, MARKER), "utf8").trim();
  } catch {
    return undefined;
  }
}

/**
 * @param {{ root?: string, sitesDir?: string, site?: string, siteDir?: string, copy?: boolean, log?: (line: string) => void }} [opts]
 *   root: the app folder (the repository root); sitesDir: the sites folder (default: <root>/sites);
 *   siteDir: the site folder itself (default: $SITE_DIR, else <sitesDir>/<site> when a site is named, else the fixture)
 * @returns {{ site: string, actions: string[] }}
 */
export function selectSite({
  root = process.cwd(),
  sitesDir = path.resolve(root, "sites"),
  site = process.env.SITE || "",
  siteDir = process.env.SITE_DIR || "",
  copy = false,
  log = () => {},
} = {}) {
  if (siteDir) siteDir = path.resolve(siteDir);
  else if (site) {
    if (!/^[a-z0-9.-]+$/.test(site) || site.startsWith(".")) throw new Error(`SITE must be a domain name, not ${JSON.stringify(site)}`);
    siteDir = path.join(sitesDir, site);
  } else siteDir = path.join(root, DEFAULT_SITE_DIR);
  if (!fs.existsSync(path.join(siteDir, "site.json"))) throw new Error(`${siteDir}/site.json not found: no such site`);
  // The name recorded in the copies' marker: the site's host, so a copy of the same site is kept by a later run.
  if (!site) site = String(JSON.parse(fs.readFileSync(path.join(siteDir, "site.json"), "utf8")).host || path.basename(siteDir));
  const actions = [];

  for (const { at, from, always } of ENTRIES) {
    const dest = path.join(root, at);
    const wantCopy = always === "copy" || copy;
    const target = typeof from === "string" ? path.relative(path.dirname(dest), path.join(siteDir, from)) : "";
    const st = lstat(dest);

    if (st?.isSymbolicLink()) {
      if (!wantCopy && fs.readlinkSync(dest) === target) continue;
      fs.unlinkSync(dest);
    } else if (st) {
      const copied = copyOf(dest);
      if (copied === undefined) throw new Error(`${at} is a real folder, not one this script made: move it into ${siteDir} and run again`);
      if (copied === site && !copy && always !== "copy") continue; // CI copies first, then npm run build keeps them
      fs.rmSync(dest, { recursive: true, force: true });
    }

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (wantCopy) {
      const parts = typeof from === "string" ? [[from, dest]] : from.map((f) => [f, path.join(dest, f)]);
      fs.mkdirSync(dest, { recursive: true });
      for (const [f, to] of parts) if (fs.existsSync(path.join(siteDir, f))) fs.cpSync(path.join(siteDir, f), to, { recursive: true });
      fs.writeFileSync(path.join(dest, MARKER), `${site}\n`);
      if (always !== "copy") actions.push(`${at}: copy of ${path.join(siteDir, from)}`);
    } else {
      fs.symlinkSync(target, dest, "dir");
      actions.push(`${at} -> ${target}`);
    }
  }
  for (const a of actions) log(a);
  return { site, actions };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const { site, actions } = selectSite({ root, copy: process.argv.includes("--copy"), log: (l) => console.log(`  ${l}`) });
    if (actions.length) console.log(`Site: ${site}`);
  } catch (err) {
    console.error(`use-site: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
