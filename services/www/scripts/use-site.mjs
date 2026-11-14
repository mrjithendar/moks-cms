#!/usr/bin/env node
/**
 * Choose which website this app serves. Everything that belongs to one website lives in sites/<domain>/ at the
 * root of the repository:
 *
 *   sites/<domain>/site.json        identity (host, name, author, social links, AdSense ID)
 *   sites/<domain>/config/          redirects, gone URLs, the /hire-me profile
 *   sites/<domain>/content/         articles, pages, authors, Python practice
 *   sites/<domain>/public/images/   images the articles use (served as /images/…)
 *   sites/<domain>/docs/            sources of the articles' figures and checks (never shipped)
 *
 * The app keeps reading site/, content/ and public/images/ in services/www (and /app/content, /app/public/images in
 * the container, where the content image copies them). This script fills those three paths from sites/$SITE:
 *
 *   site/            always a copy of site.json and config/: they are compiled into the app, and Turbopack only
 *                    compiles files inside services/www
 *   content/         a symlink for development (edit files under sites/<domain>/ as usual), or with --copy a real
 *   public/images/   copy, for CI and Docker builds (COPY and output tracing do not follow links out of the folder)
 *
 *   npm run site                      SITE=example.com npm run site      npm run site -- --copy
 *
 * dev, preview, build, typecheck and test run it first (package.json "pre" scripts). A plain run keeps copies of
 * content/ and public/images/ that are already there for the same site. It never replaces a real folder it did not
 * create.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_SITE = "jithendar.com";
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
 * @param {{ root?: string, sitesDir?: string, site?: string, copy?: boolean, log?: (line: string) => void }} [opts]
 *   root: the app folder (services/www); sitesDir: the sites folder (default: <root>/../../sites)
 * @returns {{ site: string, actions: string[] }}
 */
export function selectSite({
  root = process.cwd(),
  sitesDir = path.resolve(root, "..", "..", "sites"),
  site = process.env.SITE || DEFAULT_SITE,
  copy = false,
  log = () => {},
} = {}) {
  if (!/^[a-z0-9.-]+$/.test(site) || site.startsWith(".")) throw new Error(`SITE must be a domain name, not ${JSON.stringify(site)}`);
  const siteDir = path.join(sitesDir, site);
  if (!fs.existsSync(path.join(siteDir, "site.json"))) throw new Error(`${siteDir}/site.json not found: no such site`);
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
      if (always !== "copy") actions.push(`${at}: copy of sites/${site}/${from}`);
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
