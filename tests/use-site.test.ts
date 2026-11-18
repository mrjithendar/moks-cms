import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error -- plain .mjs script without type declarations
import { selectSite } from "../scripts/use-site.mjs";

let base: string;
let root: string; // the repository root
let sites: string; // the repository's sites/

function makeSite(domain: string) {
  const dir = path.join(sites, domain);
  fs.mkdirSync(path.join(dir, "content", "blog"), { recursive: true });
  fs.mkdirSync(path.join(dir, "public", "images"), { recursive: true });
  fs.mkdirSync(path.join(dir, "config"));
  fs.writeFileSync(path.join(dir, "site.json"), JSON.stringify({ host: domain }));
  fs.writeFileSync(path.join(dir, "config", "gone.ts"), domain);
  fs.mkdirSync(path.join(dir, "docs"));
  fs.writeFileSync(path.join(dir, "content", "blog", "a.mdx"), domain);
  fs.writeFileSync(path.join(dir, "public", "images", "a.png"), domain);
}

const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "use-site-"));
  root = base;
  sites = path.join(base, "sites");
  fs.mkdirSync(path.join(root, "public"), { recursive: true });
  fs.writeFileSync(path.join(root, "public", "favicon.ico"), "icon");
  makeSite("one.example");
  makeSite("two.example");
});
afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

const run = (site: string, copy = false) => selectSite({ root, site, siteDir: "", copy });

describe("use-site", () => {
  it("copies site/ and links content/ and public/images/ to the chosen site", () => {
    run("one.example");
    expect(fs.lstatSync(path.join(root, "content")).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(root, "public", "images"))).toBe(path.join("..", "sites", "one.example", "public", "images"));
    expect(fs.lstatSync(path.join(root, "site")).isDirectory()).toBe(true); // compiled into the app: never a link
    expect(read("site/config/gone.ts")).toBe("one.example");
    expect(fs.existsSync(path.join(root, "site", "docs"))).toBe(false); // only site.json and config/
    expect(read("content/blog/a.mdx")).toBe("one.example");
    expect(read("public/images/a.png")).toBe("one.example");
    expect(JSON.parse(read("site/site.json")).host).toBe("one.example");
    expect(read("public/favicon.ico")).toBe("icon"); // the rest of public/ is untouched
  });

  it("refreshes site/ every run, keeps correct links, and switches sites", () => {
    run("one.example");
    fs.writeFileSync(path.join(sites, "one.example", "config", "gone.ts"), "edited");
    expect(run("one.example").actions).toEqual([]);
    expect(read("site/config/gone.ts")).toBe("edited");
    run("two.example");
    expect(read("content/blog/a.mdx")).toBe("two.example");
    expect(JSON.parse(read("site/site.json")).host).toBe("two.example");
  });

  it("--copy makes real copies of content and images, which a later plain run keeps", () => {
    run("one.example");
    run("one.example", true);
    expect(fs.lstatSync(path.join(root, "content")).isDirectory()).toBe(true);
    expect(fs.lstatSync(path.join(root, "public", "images")).isSymbolicLink()).toBe(false);
    expect(read("public/images/a.png")).toBe("one.example");
    expect(run("one.example").actions).toEqual([]);
    run("two.example"); // a copy of another site is replaced
    expect(read("content/blog/a.mdx")).toBe("two.example");
  });

  it("never replaces a real folder it did not create", () => {
    fs.mkdirSync(path.join(root, "content"));
    fs.writeFileSync(path.join(root, "content", "mine.mdx"), "keep");
    expect(() => run("one.example")).toThrow(/real folder/);
    expect(read("content/mine.mdx")).toBe("keep");
  });

  it("refuses unknown sites and names that are not domains", () => {
    expect(() => run("missing.example")).toThrow(/no such site/);
    expect(() => run("../etc")).toThrow(/domain name/);
  });

  it("serves any folder named by siteDir (SITE_DIR), such as a site's own repository", () => {
    const repo = path.join(base, "repo");
    fs.cpSync(path.join(sites, "two.example"), repo, { recursive: true });
    const { site } = selectSite({ root, siteDir: repo, site: "", copy: true });
    expect(site).toBe("two.example"); // the host in its site.json
    expect(read("content/blog/a.mdx")).toBe("two.example");
    expect(read("content/.site-copy").trim()).toBe("two.example");
    expect(() => selectSite({ root, siteDir: path.join(base, "nowhere"), site: "" })).toThrow(/no such site/);
  });

  it("falls back to the test fixture site when neither SITE_DIR nor SITE is set", () => {
    const fixture = path.join(root, "tests", "fixtures", "site");
    fs.cpSync(path.join(sites, "one.example"), fixture, { recursive: true });
    expect(selectSite({ root, site: "", siteDir: "" }).site).toBe("one.example");
    expect(fs.readlinkSync(path.join(root, "content"))).toBe(path.join("tests", "fixtures", "site", "content"));
  });
});
