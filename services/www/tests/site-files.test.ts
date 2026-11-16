import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSiteFile, readSiteJson, siteConfigDir, siteFileScript, type SiteFile } from "@/config/site-files";

vi.mock("@/lib/site-config/maintenance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/site-config/maintenance")>()),
  maintenanceState: async () => ({ enabled: false, message: "", retryAfterMinutes: 30 }),
}));

let dir: string | undefined;
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** A site folder in a temp dir, used through SITE_CONFIG_DIR as a site's Deployment does with /app/site. */
function siteFolder(files: Record<string, unknown>): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "site-files-"));
  for (const [name, value] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
  }
  vi.stubEnv("SITE_CONFIG_DIR", dir);
  return dir;
}

describe("site files read at run time", () => {
  it("defaults to site/ in the working directory, which npm run site fills", () => {
    expect(siteConfigDir()).toBe(path.join(process.cwd(), "site"));
    expect(loadSiteFile().host).toBe(JSON.parse(fs.readFileSync("site/site.json", "utf8")).host);
  });

  it("reads another site's folder from SITE_CONFIG_DIR, with blanks for missing keys", () => {
    siteFolder({ "site.json": { host: "example.com", name: "Example" } });
    const file = loadSiteFile();
    expect(file).toMatchObject({ host: "example.com", name: "Example", timeZone: "UTC" });
    expect(file.social.github).toBe("");
  });

  it("uses the fallback for a missing optional file and names a missing required one", () => {
    siteFolder({ "site.json": { host: "example.com" } });
    expect(readSiteJson("config/gone.json", ["/x"])).toEqual(["/x"]);
    expect(() => readSiteJson("config/nope.json")).toThrow(/config\/nope\.json not found/);
  });

  it("writes site.json into the page without `deploy` and without a way to close the script tag", () => {
    const js = siteFileScript({ ...loadSiteFile(), name: "</script><b>", deploy: { namespace: "x" } } as SiteFile);
    expect(js).not.toContain("</script>");
    const target: Record<string, SiteFile> = {};
    new Function("globalThis", js)(target);
    expect(target.__MOKS_SITE__!.name).toBe("</script><b>");
    expect(target.__MOKS_SITE__).not.toHaveProperty("deploy");
  });

  it("the proxy answers the site's redirects and 410s from its own folder", async () => {
    siteFolder({
      "site.json": { host: "example.com" },
      "config/redirects.json": [{ source: "/old-post", destination: "/blog/new-post" }],
      "config/gone.json": ["/spam"],
    });
    const { proxy } = await import("@/proxy");
    const req = (p: string) => new NextRequest(`https://example.com${p}`, { headers: { host: "example.com" } });
    const moved = await proxy(req("/old-post/?ref=x"));
    expect(moved.status).toBe(308);
    expect(moved.headers.get("location")).toBe("https://example.com/blog/new-post?ref=x");
    expect((await proxy(req("/spam"))).status).toBe(410);
  });
});
