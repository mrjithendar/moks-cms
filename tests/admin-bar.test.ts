import { readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { beforeEach, describe, expect, it } from "vitest";
import PageCacheHandler, { pageCacheState } from "../cache-handler.mjs";
import { adminBarHeadScript, barCookie, barTarget, purgeablePath, readBarCookie, ADMIN_BAR_CLASS } from "@/lib/admin-bar";
import { dropCachedPath, purgePages } from "@/lib/page-cache";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

describe("admin bar: what page is this (barTarget)", () => {
  it("recognises posts, pages, listings, taxonomy, authors and the editor", () => {
    expect(barTarget("/")).toEqual({ kind: "home" });
    expect(barTarget("/blog/kubernetes-on-hetzner")).toEqual({ kind: "post", collection: "blog", slug: "kubernetes-on-hetzner" });
    expect(barTarget("/news/some-story/")).toEqual({ kind: "post", collection: "news", slug: "some-story" });
    expect(barTarget("/projects/moks")).toEqual({ kind: "post", collection: "projects", slug: "moks" });
    expect(barTarget("/blog")).toEqual({ kind: "listing", collection: "blog" });
    expect(barTarget("/news/page/2")).toEqual({ kind: "listing", collection: "news" });
    expect(barTarget("/category/kubernetes")).toEqual({ kind: "category", slug: "kubernetes" });
    expect(barTarget("/tag/argo%20cd")).toEqual({ kind: "tag", slug: "argo cd" });
    expect(barTarget("/authors/jithendar-dharmapuri")).toEqual({ kind: "author", slug: "jithendar-dharmapuri" });
    expect(barTarget("/about")).toEqual({ kind: "page", slug: "about" });
    expect(barTarget("/hire-me")).toEqual({ kind: "hire-me" });
    expect(barTarget("/admin/posts/0b6c0a2e-1c1f-4c86-9a43-3c3a6a1f2b10")).toEqual({ kind: "admin-post", id: "0b6c0a2e-1c1f-4c86-9a43-3c3a6a1f2b10" });
    expect(barTarget("/admin/pages/about")).toEqual({ kind: "admin-page", slug: "about" });
    expect(barTarget("/admin/pages/new")).toEqual({ kind: "admin" });
  });

  it("never treats the site's own routes, or malformed paths, as editable pages", () => {
    for (const p of ["/search", "/login", "/account", "/python-practice", "/user-manual", "/blog/a/b", "/About", "/%E0%A4%A", "/argocd/applications"]) {
      expect(barTarget(p).kind, p).toBe("other");
    }
  });
});

describe("admin bar: purgeable paths", () => {
  it("accepts public URL paths and normalises a trailing slash", () => {
    expect(purgeablePath("/")).toBe("/");
    expect(purgeablePath("/blog/my-post/")).toBe("/blog/my-post");
    expect(purgeablePath("/tag/argo%20cd")).toBe("/tag/argo%20cd");
    expect(purgeablePath("/feed.xml")).toBe("/feed.xml");
  });
  it("refuses anything else", () => {
    for (const bad of [undefined, 42, "", "blog", "//x.example/", "/a/../b", "/./a", "/x?y", "/x#y", "/a b", `/${"x".repeat(520)}`]) expect(purgeablePath(bad), String(bad)).toBeNull();
  });
});

describe("admin bar: hint cookie and head script", () => {
  it("round-trips the preference and clears it", () => {
    expect(barCookie("on", true)).toBe("moks-adminbar=on; Path=/; SameSite=Lax; Secure; Max-Age=31536000");
    expect(barCookie(null, false)).toBe("moks-adminbar=; Path=/; SameSite=Lax; Max-Age=0");
    expect(readBarCookie("a=1; moks-adminbar=off; b=2")).toBe("off");
    expect(readBarCookie("moks-adminbar=on")).toBe("on");
    expect(readBarCookie("moks-adminbar=yes")).toBeNull();
    expect(readBarCookie("")).toBeNull();
  });

  function run(pathname: string, cookie: string, framed = false) {
    const classes = new Set<string>();
    const win: Record<string, unknown> = {};
    win.top = framed ? {} : win;
    win.self = win;
    runInNewContext(adminBarHeadScript(), {
      window: win,
      location: { pathname },
      document: { cookie, documentElement: { classList: { add: (c: string) => classes.add(c) } } },
    });
    return classes.has(ADMIN_BAR_CLASS);
  }

  it("reserves the bar's space before paint only where it will show", () => {
    expect(run("/admin/posts", "")).toBe(true); // the admin always has it
    expect(run("/blog/x", "moks-adminbar=on")).toBe(true);
    expect(run("/blog/x", "")).toBe(false); // readers: nothing changes
    expect(run("/blog/x", "moks-adminbar=off")).toBe(false); // hidden on the site
    expect(run("/admin", "moks-adminbar=off")).toBe(true);
    expect(run("/preview/abc", "moks-adminbar=on")).toBe(false);
    expect(run("/blog/x", "moks-adminbar=on", true)).toBe(false); // framed (device previews)
  });

  it("is in the root layout's head, and the bar is never server-rendered into cached pages", () => {
    const layout = read("src/app/layout.tsx");
    expect(layout).toContain("adminBarHeadScript()");
    expect(layout).toContain("<AdminBar />");
    expect(read("src/components/admin-bar/AdminBar.tsx").startsWith('"use client";')).toBe(true);
  });

  it("offsets sticky chrome by the bar (no element pinned under it)", () => {
    expect(read("src/app/theme-tokens.css")).toContain("--spacing-chrome: calc(var(--spacing-header) + var(--adminbar-h, 0px))");
    expect(read("src/components/SiteHeader.tsx")).toContain("sticky top-(--adminbar-h)");
    for (const f of ["src/app/admin/posts/PostEditor.tsx", "src/app/admin/pages/PageEditor.tsx", "src/app/admin/appearance/AppearanceEditor.tsx", "src/components/admin/AdminNav.tsx", "src/components/guide/GuideBrowser.tsx"]) {
      expect(read(f), f).not.toMatch(/\btop-header\b/);
    }
  });
});

const page = (html: string) => ({ kind: "APP_PAGE", html, rscData: Buffer.from(html), headers: {}, status: 200 });
const key = (p: string) => `/route-cache/APP_PAGE/${"a".repeat(64)}/$${p}`;

describe("page cache: purge one path", () => {
  beforeEach(() => {
    const s = pageCacheState();
    s.entries.clear();
    s.pending.clear();
    s.bytes = 0;
  });

  it("drops only that page, as Next names it (/ is stored as /index)", async () => {
    const h = new PageCacheHandler({});
    for (const p of ["/index", "/blog", "/blog/a", "/news/blog"]) {
      await h.get(key(p));
      await h.set(key(p), page(p));
    }
    const before = pageCacheState().bytes;
    expect(dropCachedPath("/blog")).toBe(1);
    expect(await h.get(key("/blog"))).toBeNull();
    expect((await h.get(key("/blog/a")))?.value.html).toBe("/blog/a");
    expect((await h.get(key("/news/blog")))?.value.html).toBe("/news/blog");
    expect(pageCacheState().bytes).toBeLessThan(before);

    expect(dropCachedPath("/")).toBe(1);
    expect(await h.get(key("/index"))).toBeNull();
  });

  it("does not store a render of that page that was running during the purge", async () => {
    const h = new PageCacheHandler({});
    expect(await h.get(key("/blog/a"))).toBeNull(); // a render starts with the old data
    dropCachedPath("/blog/a");
    await h.set(key("/blog/a"), page("stale"));
    expect(await h.get(key("/blog/a"))).toBeNull();
    await h.set(key("/blog/a"), page("fresh")); // the render that started after the purge
    expect((await h.get(key("/blog/a")))?.value.html).toBe("fresh");
  });

  it("purgePages clears here at once: one path, or every page", async () => {
    const h = new PageCacheHandler({});
    for (const p of ["/a", "/b"]) {
      await h.get(key(p));
      await h.set(key(p), page(p));
    }
    expect(purgePages("/a/")).toBe(true);
    expect(await h.get(key("/a"))).toBeNull();
    expect(await h.get(key("/b"))).not.toBeNull();
    expect(purgePages("not a path")).toBe(false);
    expect(purgePages(null)).toBe(true);
    expect(await h.get(key("/b"))).toBeNull();
  });
});
