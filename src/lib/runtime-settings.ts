import "server-only";
import { eq } from "drizzle-orm";
import { adsTxt, integrations, READER_REVENUE_PRODUCT, type Integrations } from "@/config/integrations";
import { getDb, schema } from "@/db";
import { audit } from "./audit";
import { broadcastInvalidate, onInvalidate } from "./cache-bus";
import type { Actor } from "./posts";
import { PostError } from "./posts";
import { seal, unseal, type Sealed } from "./secrets";

/**
 * Runtime settings: options that used to exist only as environment variables. There is no page of their own: each
 * group is shown on the admin page it belongs to (`page`, e.g. Razorpay on Payments, Cal.com on Bookings; rendered by
 * components/admin/RuntimeSettings.tsx). Each field keeps its
 * environment-variable name, and the code reads it through effectiveEnv(): a value saved in the admin wins, an
 * empty field falls back to the deployment's value. Secrets are sealed with SETTINGS_ENCRYPTION_KEY and never
 * sent back to the browser. Changes apply on every replica at once (Redis invalidation; Better Auth is rebuilt).
 *
 * Deliberately NOT here (the admin cannot run, or could lock itself out, without them): DATABASE_URL,
 * REDIS_URL, BETTER_AUTH_SECRET, SETTINGS_ENCRYPTION_KEY, SITE_URL, ADMIN_BOOTSTRAP_TOKEN, APP_ENV, and
 * process-level options read once at start-up (LOG_LEVEL, ACCESS_LOG, OTEL_*, METRICS_PORT, paths).
 */
export type FieldType = "text" | "secret" | "number" | "boolean" | "select" | "textarea";
export type Field = {
  env: string;
  label: string;
  type: FieldType;
  hint?: string;
  placeholder?: string;
  /** Text/secret: allowed pattern. Number: min/max. */
  pattern?: RegExp;
  min?: number;
  max?: number;
  options?: { value: string; label: string }[];
};
/** `page`: the admin page that shows this group; the group's form sits at `${page}#${id}` (see settingHref). */
export type Group = { id: string; title: string; description: string; page: string; fields: Field[] };

const TOKEN_LIST = /^$|^[A-Za-z0-9_-]{10,100}(\s*,\s*[A-Za-z0-9_-]{10,100})*$/;

export const GROUPS: Group[] = [
  {
    id: "verification",
    page: "/admin/integrations",
    title: "Search engine verification",
    description: "Proves ownership of jithendar.com in Google Search Console and Bing Webmaster Tools (rendered as <meta> tags). Several tokens: separate with commas.",
    fields: [
      { env: "GOOGLE_SITE_VERIFICATION", label: "Google Search Console token", type: "text", pattern: TOKEN_LIST, placeholder: "content value of google-site-verification" },
      { env: "BING_SITE_VERIFICATION", label: "Bing Webmaster token", type: "text", pattern: TOKEN_LIST, placeholder: "content value of msvalidate.01" },
    ],
  },
  {
    id: "analytics",
    page: "/admin/integrations",
    title: "Analytics, ads and consent",
    description: "Google Analytics 4, AdSense and Reader Revenue Manager load only in production and only on public pages; analytics and ads wait for consent where the law requires it.",
    fields: [
      { env: "GA4_MEASUREMENT_ID", label: "GA4 measurement ID", type: "text", pattern: /^$|^G-[A-Z0-9]{4,16}$/, placeholder: "G-XXXXXXXXXX" },
      { env: "ADSENSE_CLIENT_ID", label: "AdSense publisher ID", type: "text", pattern: /^$|^off$|^ca-pub-\d{10,20}$/, placeholder: "ca-pub-2479369059565142", hint: "Empty: ca-pub-2479369059565142 (jithendar.com's account). \"off\" disables ads." },
      { env: "ADSENSE_SLOT_ARTICLE_END", label: "Ad slot: end of article", type: "text", pattern: /^$|^\d{6,20}$/ },
      { env: "ADSENSE_SLOT_LISTING", label: "Ad slot: listings", type: "text", pattern: /^$|^\d{6,20}$/ },
      { env: "ADSENSE_TEST_MODE", label: "Show Google test ads outside production", type: "boolean" },
      {
        env: "CONSENT_DEFAULT",
        label: "Consent default",
        type: "select",
        options: [
          { value: "regional", label: "Regional: ask in EEA, UK and Switzerland; allowed elsewhere" },
          { value: "strict", label: "Strict: ask everyone before analytics or ads" },
        ],
      },
      { env: "ADS_TXT", label: "ads.txt", type: "textarea", hint: "Exactly the line(s) your AdSense account gives you; served at /ads.txt. Empty: /ads.txt returns 404." },
      {
        env: "READER_REVENUE_PRODUCT_ID",
        label: "Reader Revenue Manager product ID",
        type: "text",
        pattern: new RegExp(`^$|^off$|${READER_REVENUE_PRODUCT.source}`),
        placeholder: "ABCDEFGHIJ:openaccess",
        hint: "Google Publisher Center → Reader Revenue Manager → Add code to your site: the isPartOfProductId value. Empty: readerRevenue.productId in site.json (none if unset). \"off\" turns it off.",
      },
    ],
  },
  {
    id: "turnstile",
    page: "/admin/integrations",
    title: "Human verification (Cloudflare Turnstile)",
    description: "Protects sign-in, sign-up, comments and the contact form. Cloudflare dashboard → Turnstile → your widget. Wrong keys block sign-in: test in a private window after saving.",
    fields: [
      { env: "TURNSTILE_SITE_KEY", label: "Site key", type: "text", pattern: /^$|^[0-9A-Za-z_-]{10,100}$/ },
      { env: "TURNSTILE_SECRET_KEY", label: "Secret key", type: "secret", pattern: /^$|^[0-9A-Za-z_.-]{10,200}$/ },
    ],
  },
  {
    id: "cloudflare",
    title: "Cloudflare settings",
    description:
      "Lets the admin bar's Cache menu, Admin → Cache and publishing purge Cloudflare's copies of your pages, when Cloudflare is in front of the site. Cloudflare dashboard → your domain → Overview: Zone ID. My Profile → API Tokens (or Manage account → Account API tokens) → Create Token → Custom token: permission Zone → Cache Purge → Purge, zone resources: this domain only (optional: Zone → Zone → Read, to show the zone and plan in Admin → Cache). Then Test connection on the Cloudflare card above.",
    page: "/admin/cache",
    fields: [
      { env: "CLOUDFLARE_ZONE_ID", label: "Zone ID", type: "text", pattern: /^$|^[a-f0-9]{32}$/, placeholder: "32 hexadecimal characters" },
      { env: "CLOUDFLARE_API_TOKEN", label: "API token", type: "secret", pattern: /^$|^[\x21-\x7e]{20,300}$/, hint: "Only Cache Purge on this zone. Never shown again after saving." },
      {
        env: "CLOUDFLARE_PURGE_ON_PUBLISH",
        label: "Purge Cloudflare when content changes",
        type: "select",
        options: [
          { value: "related", label: "The changed page and the pages that list it (home, listings, feeds, category, tags, author, sitemaps)" },
          { value: "everything", label: "Everything, on every change" },
          { value: "off", label: "Off: Cloudflare refreshes pages on its own schedule" },
        ],
        hint: "Applies when a post, news story, project or page is published, updated, scheduled to go live, unpublished or deleted. Site-wide changes (Appearance, menus, categories) purge everything unless this is Off. Deployment default: the changed page and the pages that list it.",
      },
    ],
  },
  {
    id: "calcom",
    page: "/admin/bookings",
    title: "Cal.com bookings",
    description:
      "Bookings, reschedules and cancellations from Cal.com appear in Admin → Bookings. In Cal.com: Settings → Developer → Webhooks → New: subscriber URL https://jithendar.com/api/cal/webhook, events Booking created, rescheduled, cancelled, requested and rejected, and a secret. Paste the same secret here; requests without a valid signature are refused.",
    fields: [{ env: "CAL_WEBHOOK_SECRET", label: "Webhook secret", type: "secret", pattern: /^$|^[\x21-\x7e]{16,200}$/, hint: "At least 16 characters; any printable characters without spaces." }],
  },
  {
    id: "razorpay",
    page: "/admin/payments",
    title: "Razorpay payments (paid calls and invoices)",
    description:
      "Paid calls on /hire-me (Admin → Appearance → Hire me → Paid calls) and the payment links on invoices (Admin → Invoices). Razorpay Dashboard → Account & Settings → API keys: Key ID and Key secret (use rzp_test_ keys first). Then Webhooks → Add: URL https://jithendar.com/api/razorpay/webhook, events payment.captured, payment.failed and order.paid for paid calls and payment_link.paid, payment_link.cancelled and payment_link.expired for invoices, and a secret; paste the same secret here. Payments in a currency other than INR need International payments enabled on the Razorpay account.",
    fields: [
      { env: "RAZORPAY_KEY_ID", label: "Key ID", type: "text", pattern: /^$|^rzp_(test|live)_[A-Za-z0-9]{10,30}$/, placeholder: "rzp_live_…", hint: "Public: sent to the visitor's browser to open Checkout." },
      { env: "RAZORPAY_KEY_SECRET", label: "Key secret", type: "secret", pattern: /^$|^[A-Za-z0-9]{10,100}$/ },
      { env: "RAZORPAY_WEBHOOK_SECRET", label: "Webhook secret", type: "secret", pattern: /^$|^[\x21-\x7e]{12,200}$/, hint: "At least 12 printable characters, no spaces." },
    ],
  },
  {
    id: "image-limits",
    page: "/admin/integrations",
    title: "Image generation limits",
    description: "Caps on Gemini usage (each image costs money). The key and model are under Image generation (Gemini).",
    fields: [
      { env: "GEMINI_IMAGE_USER_HOURLY_LIMIT", label: "Images per author per hour", type: "number", min: 0, max: 1000, placeholder: "10" },
      { env: "GEMINI_IMAGE_DAILY_LIMIT", label: "Images per day (whole site)", type: "number", min: 0, max: 10000, placeholder: "50" },
      { env: "GEMINI_IMAGE_USER_CONCURRENCY", label: "Parallel generations per author", type: "number", min: 1, max: 5, placeholder: "1" },
      { env: "GEMINI_IMAGE_TIMEOUT_MS", label: "Timeout (milliseconds)", type: "number", min: 5000, max: 300000, placeholder: "90000" },
    ],
  },
  {
    id: "video-generation",
    page: "/admin/integrations",
    title: "Video generation",
    description:
      "Short AI clips for articles (editor → Generate → Video), made with a Veo model through the Gemini API using the Gemini key from Integrations. Off until a model is set. Each clip costs far more than an image, so the limits are low.",
    fields: [
      { env: "GEMINI_VIDEO_MODEL", label: "Video model", type: "text", pattern: /^$|^[a-z0-9][a-z0-9.\-]{2,99}$/, placeholder: "veo-…", hint: "The model code from ai.google.dev (Veo). Empty turns video generation off." },
      { env: "GEMINI_VIDEO_RESOLUTION", label: "Resolution (optional)", type: "text", pattern: /^$|^[0-9a-zA-Z]{2,8}$/, placeholder: "720p", hint: "Sent only when set; not every model accepts every value." },
      { env: "GEMINI_VIDEO_SECONDS", label: "Clip length in seconds (optional)", type: "number", min: 1, max: 60, placeholder: "model default" },
      { env: "GEMINI_VIDEO_USER_HOURLY_LIMIT", label: "Videos per author per hour", type: "number", min: 0, max: 100, placeholder: "3" },
      { env: "GEMINI_VIDEO_DAILY_LIMIT", label: "Videos per day (whole site)", type: "number", min: 0, max: 1000, placeholder: "10" },
      { env: "GEMINI_VIDEO_TIMEOUT_MS", label: "Give up after (milliseconds)", type: "number", min: 60000, max: 1800000, placeholder: "600000" },
    ],
  },
  {
    id: "rag",
    page: "/admin/integrations",
    title: "Hybrid RAG (moks-rag)",
    description:
      "Keeps published posts in the shared Hybrid RAG service (rag-api, Qdrant) so they can be searched by meaning: publishing or updating a post indexes it, unpublishing, trashing or deleting it removes it. Sent in the background with retries; saving never waits for it. Off until a bearer token is set (here or as RAG_BEARER_TOKEN in the deployment).",
    fields: [
      { env: "RAG_API_URL", label: "rag-api address", type: "text", pattern: /^$|^https?:\/\/[^\s]{3,300}$/, placeholder: "http://rag-api.rag.svc.cluster.local:8000", hint: "Empty: http://rag-api.rag.svc.cluster.local:8000 (rag-api inside the cluster)." },
      { env: "RAG_BEARER_TOKEN", label: "Bearer token", type: "secret", pattern: /^$|^[\x21-\x7e]{16,300}$/, hint: "rag-api's RAG_BEARER_TOKEN (Secret rag-secrets in namespace rag). Never shown again after saving." },
      { env: "RAG_COLLECTION", label: "Collection", type: "text", pattern: /^$|^[a-z0-9_]{1,64}$/, placeholder: "cms_content", hint: "Empty: cms_content." },
      { env: "RAG_SERVICE_NAME", label: "Service name (X-Service-Name)", type: "text", pattern: /^$|^[a-z0-9][a-z0-9._-]{0,62}$/, placeholder: "moks-cms", hint: "How rag-api's logs name this site. Empty: moks-cms." },
    ],
  },
  {
    id: "members",
    page: "/admin/users",
    title: "Members-only articles",
    description:
      "A post marked “Members only” in the editor shows signed-out readers the first part of the article and a prompt to sign in or create an account. This is how much they see by default; a single post can set its own percentage in the editor.",
    fields: [{ env: "MEMBERS_PREVIEW_PERCENT", label: "Public preview (% of the article)", type: "number", min: 5, max: 95, placeholder: "30", hint: "The cut is made between paragraphs, so the real share is the nearest whole block at or above this." }],
  },
  {
    id: "video-destinations",
    page: "/admin/storage",
    title: "Video destinations",
    description:
      "Where a generated video can go when an author inserts it. The editor offers only destinations that are switched on here and fully filled in. This site's own media library (R2) plays the file directly; Cloudflare Stream, Mux and Bunny Stream encode it for adaptive streaming and the article embeds their player (the video then lives in that service's account, not in Admin → Media).",
    fields: [
      { env: "VIDEO_DEST_R2_DISABLED", label: "Turn OFF this site's own media library (R2) as a destination", type: "boolean", hint: "It is on unless this is ticked." },
      { env: "CF_STREAM_ENABLED", label: "Cloudflare Stream", type: "boolean" },
      { env: "CF_STREAM_ACCOUNT_ID", label: "Cloudflare account ID", type: "text", pattern: /^$|^[a-f0-9]{32}$/ },
      { env: "CF_STREAM_API_TOKEN", label: "Cloudflare API token", type: "secret", pattern: /^$|^[A-Za-z0-9_\-]{20,200}$/, hint: "A token with the Stream: Edit permission only." },
      { env: "CF_STREAM_CUSTOMER_CODE", label: "Stream customer code", type: "text", pattern: /^$|^[a-z0-9]{6,40}$/, placeholder: "the code in customer-<code>.cloudflarestream.com", hint: "Shown in any Stream embed code in the Cloudflare dashboard." },
      { env: "MUX_ENABLED", label: "Mux", type: "boolean" },
      { env: "MUX_TOKEN_ID", label: "Mux token ID", type: "text", pattern: /^$|^[A-Za-z0-9\-]{10,100}$/ },
      { env: "MUX_TOKEN_SECRET", label: "Mux token secret", type: "secret", pattern: /^$|^[A-Za-z0-9+\/=_\-]{20,200}$/, hint: "An access token with Mux Video read and write." },
      { env: "BUNNY_STREAM_ENABLED", label: "Bunny Stream", type: "boolean" },
      { env: "BUNNY_STREAM_LIBRARY_ID", label: "Bunny video library ID", type: "text", pattern: /^$|^\d{1,10}$/ },
      { env: "BUNNY_STREAM_API_KEY", label: "Bunny library API key", type: "secret", pattern: /^$|^[A-Za-z0-9\-]{20,100}$/, hint: "The Stream library's own key (Stream → library → API), not the account key." },
    ],
  },
  {
    id: "avatars",
    page: "/admin/users",
    title: "Profile pictures",
    description: "Limits for pictures readers upload on their account page (always re-encoded to 512 px WebP).",
    fields: [
      { env: "AVATAR_MAX_BYTES", label: "Largest upload (bytes)", type: "number", min: 65536, max: 10485760, placeholder: "2097152", hint: "2097152 = 2 MB" },
      { env: "AVATAR_MAX_DIMENSION", label: "Largest side (px)", type: "number", min: 256, max: 12000, placeholder: "4096" },
      { env: "AVATAR_MIN_DIMENSION", label: "Smallest side (px)", type: "number", min: 16, max: 1024, placeholder: "64" },
    ],
  },
];

/** Where a group's form is: its page and the group's anchor on it. */
export function settingHref(groupId: string): string {
  const g = GROUPS.find((x) => x.id === groupId);
  if (!g) throw new Error(`Unknown settings group ${groupId}`);
  return `${g.page}#${g.id}`;
}

const FIELDS = new Map(GROUPS.flatMap((g) => g.fields.map((f) => [f.env, f] as const)));
const KEY = "runtime";

type Stored = { values: Record<string, string>; secrets: Record<string, Sealed> };
let cached: Promise<Stored> | null = null;
onInvalidate("integrations", () => {
  cached = null;
});

async function readStored(): Promise<Stored> {
  cached ??= (async () => {
    const db = await getDb();
    const [row] = await db.select().from(schema.setting).where(eq(schema.setting.key, KEY));
    const v = (row?.value as Partial<Stored> | undefined) ?? {};
    return { values: v.values ?? {}, secrets: v.secrets ?? {} };
  })().catch((err) => {
    cached = null;
    throw err;
  });
  return cached;
}

/**
 * process.env with every runtime setting saved in the admin laid over it. Pass it to the existing env-reading
 * helpers (integrations(), adsTxt(), avatarLimits(), generationLimits()…). Never throws: with the database
 * unavailable it is just process.env.
 */
export async function effectiveEnv(): Promise<Record<string, string | undefined>> {
  const stored = await readStored().catch(() => ({ values: {}, secrets: {} }) as Stored);
  const env: Record<string, string | undefined> = { ...process.env };
  for (const [k, v] of Object.entries(stored.values)) if (FIELDS.has(k) && v !== "") env[k] = v;
  for (const [k, v] of Object.entries(stored.secrets)) {
    if (!FIELDS.has(k)) continue;
    try {
      env[k] = unseal(v);
    } catch {
      /* sealed with another SETTINGS_ENCRYPTION_KEY: ignore, the deployment value applies */
    }
  }
  return env;
}

export type FieldState = { env: string; value: string; hasSecret: boolean; fromDeployment: string | null; secretInDeployment: boolean };

/** What the admin form may show: saved values, whether a secret is stored, and the deployment fallback (never secrets). */
export async function runtimeSummary(): Promise<Record<string, FieldState>> {
  const stored = await readStored();
  const out: Record<string, FieldState> = {};
  for (const f of FIELDS.values()) {
    const env = process.env[f.env]?.trim() || null;
    out[f.env] = {
      env: f.env,
      value: f.type === "secret" ? "" : (stored.values[f.env] ?? ""),
      hasSecret: Boolean(stored.secrets[f.env]),
      fromDeployment: f.type === "secret" ? null : env,
      secretInDeployment: f.type === "secret" && Boolean(env),
    };
  }
  return out;
}

/**
 * Save one group. Empty text/number fields clear the admin value (deployment value applies again); an empty
 * secret field keeps the stored secret unless "clear" is ticked.
 */
export async function saveRuntimeGroup(actor: Actor, groupId: string, input: Record<string, string>, clearSecrets: string[] = []) {
  if (actor.role !== "admin") throw new PostError("Only admins can change these settings.", 403);
  const group = GROUPS.find((g) => g.id === groupId);
  if (!group) throw new PostError("Unknown settings group.", 404);
  const stored = await readStored();
  const values = { ...stored.values };
  const secrets = { ...stored.secrets };
  const issues: string[] = [];
  const changed: string[] = [];
  for (const f of group.fields) {
    const raw = (input[f.env] ?? "").replace(/\r\n?/g, "\n");
    const v = f.type === "textarea" ? raw.trim() : raw.trim();
    if (f.type === "secret") {
      if (clearSecrets.includes(f.env)) {
        if (secrets[f.env]) changed.push(f.env);
        delete secrets[f.env];
      } else if (v) {
        if (f.pattern && !f.pattern.test(v)) issues.push(`${f.label}: not a valid value.`);
        else {
          secrets[f.env] = seal(v);
          changed.push(f.env);
        }
      }
      continue;
    }
    if (f.type === "boolean") {
      const next = v === "true" ? "true" : "";
      if ((values[f.env] ?? "") !== next) changed.push(f.env);
      if (next) values[f.env] = next;
      else delete values[f.env];
      continue;
    }
    if (f.type === "number" && v !== "") {
      const n = Number(v);
      if (!Number.isInteger(n) || (f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) {
        issues.push(`${f.label}: a whole number from ${f.min} to ${f.max}.`);
        continue;
      }
    }
    if (f.type === "select" && v !== "" && !f.options?.some((o) => o.value === v)) {
      issues.push(`${f.label}: choose one of the options.`);
      continue;
    }
    if (f.type === "textarea" && v.length > 10_000) {
      issues.push(`${f.label}: at most 10,000 characters.`);
      continue;
    }
    if (f.pattern && !f.pattern.test(v)) {
      issues.push(`${f.label}: not a valid value.`);
      continue;
    }
    if ((values[f.env] ?? "") !== v) changed.push(f.env);
    if (v) values[f.env] = v;
    else delete values[f.env];
  }
  if (issues.length) throw new PostError("Some values are not valid.", 400, issues);
  const db = await getDb();
  const value = { values, secrets };
  await db
    .insert(schema.setting)
    .values({ key: KEY, value, updatedBy: actor.id })
    .onConflictDoUpdate({ target: schema.setting.key, set: { value, updatedBy: actor.id, updatedAt: new Date() } });
  broadcastInvalidate("integrations");
  // Names only: values (and certainly secrets) stay out of the audit log.
  await audit(actor, "integrations.runtime", groupId, { changed });
}

/** Analytics, ads, verification and consent with the admin's runtime settings applied (see config/integrations.ts). */
export async function runtimeIntegrations(): Promise<Integrations> {
  return integrations(await effectiveEnv());
}

/** /ads.txt body with the admin's runtime settings applied. */
export async function runtimeAdsTxt(): Promise<string | null> {
  return adsTxt(await effectiveEnv());
}
