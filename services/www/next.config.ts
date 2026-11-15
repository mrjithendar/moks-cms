import path from "node:path";
import type { NextConfig } from "next";
import { redirects } from "./src/config/redirects";

const siteRoot = import.meta.dirname;

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // The Istio ingress gateway compresses responses (zstd/br/gzip, text only; EnvoyFilter response-compression in the
  // miniKube repo, deploy/minikube/istio/edge).
  compress: false,
  images: {
    // The transformation pipeline: next/image (sharp, inside the site's pods) resizes and re-encodes our
    // own files only; R2 stores originals and never transforms anything. Requests are bounded:
    // - sources: only /images/** (shipped with the site) and /media/** (uploads) — never arbitrary URLs;
    // - widths: only the sizes below (srcset candidates), one quality, two formats → ≤ 20 variants per image;
    // - originals over maximumResponseBody are refused; redirects are not followed;
    // - variants are cached on disk (LRU, capped below the pod's 256 MiB emptyDir) for 30 days.
    localPatterns: [{ pathname: "/images/**" }, { pathname: "/media/**" }],
    formats: ["image/avif", "image/webp"],
    qualities: [75],
    deviceSizes: [640, 750, 828, 1080, 1200, 1920],
    imageSizes: [96, 128, 256, 384],
    maximumResponseBody: 12_000_000,
    maximumRedirects: 0,
    maximumDiskCacheSize: 200_000_000,
    minimumCacheTTL: 60 * 60 * 24 * 30,
  },
  // src/proxy.ts strips trailing slashes itself, after answering 410 for gone URLs in one hop.
  skipTrailingSlashRedirect: true,
  reactStrictMode: true,
  // The app lives in services/www/ of the moks-cms repository; keep tracing and Turbopack scoped to it. The site it
  // serves is copied or linked into site/, content/ and public/images/ from the repository's sites/<domain>/ (scripts/use-site.mjs).
  outputFileTracingRoot: siteRoot,
  turbopack: { root: siteRoot },
  // Content is read from disk at request time (sitemaps, ISR), so ship it with the server.
  // Content is the one-time import source for /setup; migrations run at server start (instrumentation.ts).
  outputFileTracingIncludes: { "/**/*": [path.join("content", "**", "*"), path.join("src", "db", "migrations", "**", "*")] },
  // ISR: public pages are rendered once and served from memory (cache-handler.mjs), re-rendered after their
  // `revalidate` and cleared at once on every replica when content or settings change (src/lib/page-cache.ts).
  // The handler is the only cache layer (cacheMaxMemorySize: 0) and never writes to disk (read-only root filesystem);
  // a restarted pod starts empty and src/lib/warm.ts renders the site again.
  cacheHandler: path.join(siteRoot, "cache-handler.mjs"),
  cacheMaxMemorySize: 0,
  // How long a cached page may still be served while it re-renders: Next sends it as `stale-while-revalidate`
  // (expireTime − revalidate). The default is a year, which would let a CDN in front serve year-old pages; a day is
  // plenty, since pages refresh every 5 minutes and the warm-up re-renders them after every change.
  expireTime: 86_400,
  // Server actions accept image uploads up to 10 MB (plus multipart overhead); larger files
  // (video, audio, PDF) go straight to R2 with presigned URLs and never pass through the app.
  experimental: { serverActions: { bodySizeLimit: "11mb" } },
  // PGlite (local dev only) loads its WASM from a file URL that bundling breaks: load it from
  // node_modules instead of bundling.
  serverExternalPackages: ["@electric-sql/pglite"],
  async redirects() {
    return redirects.map(({ source, destination }) => ({ source, destination, permanent: true }));
  },
  async headers() {
    return [
      {
        // Uploaded originals: cache for a day, revalidate in the background for a week.
        source: "/images/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" }],
      },
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // HTTPS only (the Istio gateway redirects http → https). No includeSubDomains/preload: other hosts are not ours to commit.
          { key: "Strict-Transport-Security", value: "max-age=31536000" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
        ],
      },
      // The favicon (app/icon.svg) changes only with a deploy: browsers may keep it a day instead of re-checking it on
      // every page (Next sends max-age=0 for it).
      { source: "/icon.svg", headers: [{ key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" }] },
      // Pages may not be framed by other sites; editor previews may be framed by the editor itself.
      // Other sites may not frame any page (clickjacking); the site itself may, for the admin's device previews.
      // No plugins (<object>, <embed>) and no <base> pointing relative URLs at another origin: the site uses neither,
      // and both turn an HTML injection into something worse.
      { source: "/((?!preview/).*)", headers: [{ key: "X-Frame-Options", value: "SAMEORIGIN" }, { key: "Content-Security-Policy", value: "frame-ancestors 'self'; object-src 'none'; base-uri 'self'" }] },
      { source: "/preview/:path*", headers: [{ key: "X-Frame-Options", value: "SAMEORIGIN" }, { key: "Cache-Control", value: "private, no-store" }] },
      // Per-user responses are never stored by browsers' shared caches or any proxy.
      { source: "/account/:path*", headers: [{ key: "Cache-Control", value: "private, no-store" }] },
      { source: "/account", headers: [{ key: "Cache-Control", value: "private, no-store" }] },
      { source: "/api/auth/:path*", headers: [{ key: "Cache-Control", value: "private, no-store" }] },
      // A client's invoice link: private to whoever holds it, and never in a search index.
      { source: "/invoice/:path*", headers: [{ key: "Cache-Control", value: "private, no-store" }, { key: "X-Robots-Tag", value: "noindex, nofollow" }] },
      // Admin pages and APIs and the sign-in page: never stored, so Back after signing out asks the server again.
      { source: "/admin", headers: [{ key: "Cache-Control", value: "private, no-store" }] },
      { source: "/admin/:path*", headers: [{ key: "Cache-Control", value: "private, no-store" }] },
      { source: "/api/admin/:path*", headers: [{ key: "Cache-Control", value: "private, no-store" }] },
      { source: "/api/comments/:path*", headers: [{ key: "Cache-Control", value: "private, no-store" }] },
      { source: "/api/practice/:path*", headers: [{ key: "Cache-Control", value: "private, no-store" }] },
      { source: "/login", headers: [{ key: "Cache-Control", value: "private, no-store" }] },
    ];
  },
};

export default nextConfig;
