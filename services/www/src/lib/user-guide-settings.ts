import "server-only";
import { SCOPES } from "./mcp-oauth/oauth";
import { GROUPS } from "./runtime-settings";
import { FIELD_HELP, leafPaths, SECTION_LABELS, SETTINGS_TABS, tabOf, type Json } from "./seo-intel/settings-meta";
import { DEFAULT_SEO_SETTINGS } from "./seo-intel/settings";

/**
 * The settings reference in the user guide: every setting and option, what it does and its default. Defaults only,
 * never a stored value, so the same reference can be public.
 *
 * Generated from the code where the code has a registry (Automation & AI from DEFAULT_SEO_SETTINGS and its help
 * text, Advanced settings from runtime-settings GROUPS, MCP scopes from the OAuth server), so it cannot drift; the
 * Appearance, Integrations and Storage forms have no registry and are described here from their labels.
 */

export type SettingRow = { name: string; key?: string; help?: string; default?: string };
export type SettingsGroup = { id: string; area: string; title: string; description?: string; href: string; rows: SettingRow[] };

const humanize = (k: string) => k.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ").replace(/^\w/, (c) => c.toUpperCase());

function fmt(v: Json | undefined): string {
  if (v === undefined || v === null || v === "") return "empty";
  if (typeof v === "boolean") return v ? "on" : "off";
  if (Array.isArray(v)) return v.length ? v.join(", ") : "none";
  return String(v);
}

function getPath(obj: Json, path: string): Json | undefined {
  let cur: Json | undefined = obj;
  for (const k of path.split(".")) cur = cur && typeof cur === "object" && !Array.isArray(cur) ? (cur as Record<string, Json>)[k] : undefined;
  return cur;
}

function seoGroups(): SettingsGroup[] {
  const doc = { ...DEFAULT_SEO_SETTINGS, llmKey: undefined } as unknown as Json;
  const sections = Object.keys(DEFAULT_SEO_SETTINGS).filter((k) => k !== "llmKey");
  const tabs = [...SETTINGS_TABS, { id: "other", label: "Other", sections: [], description: "" }];
  return tabs.flatMap((tab) => {
    const mine = sections.filter((s) => tabOf(s) === tab.id);
    if (!mine.length) return [];
    return mine.map((section) => ({
      id: `seo-${section}`,
      area: "Automation & AI",
      title: `${tab.label}: ${SECTION_LABELS[section] ?? humanize(section)}`,
      description: tab.description,
      href: "/admin/automation",
      rows: leafPaths(getPath(doc, section) ?? {}, [section]).map((path) => ({
        name: path.split(".").slice(1).map(humanize).join(" › "),
        key: path,
        help: FIELD_HELP[path],
        default: fmt(getPath(doc, path)),
      })),
    }));
  });
}

function advancedGroups(): SettingsGroup[] {
  return GROUPS.map((g) => ({
    id: `advanced-${g.id}`,
    area: "Advanced settings",
    title: g.title,
    description: `${g.description} An empty field uses the deployment's environment variable of the same name.`,
    href: "/admin/advanced",
    rows: g.fields.map((f) => ({
      name: f.label,
      key: f.env,
      help: [f.hint, f.options ? `Options: ${f.options.map((o) => o.label).join(", ")}.` : "", f.type === "secret" ? "Secret: encrypted, never shown again." : ""].filter(Boolean).join(" ") || undefined,
      default: f.type === "boolean" ? "off" : "from the environment",
    })),
  }));
}

const r = (name: string, help?: string, def?: string): SettingRow => ({ name, help, default: def });

/** Appearance & settings (lib/site-config/schema.ts defaultConfig; labels from app/admin/appearance/panels.tsx). */
const APPEARANCE: Omit<SettingsGroup, "area" | "href">[] = [
  {
    id: "appearance-general",
    title: "General",
    description: "Every Appearance change is saved as a private draft, previewed on the real pages and published explicitly; Revision history keeps every version for rollback.",
    rows: [
      r("Site name"),
      r("Publication name", "Used in news sitemaps and structured data."),
      r("Tagline", "Shown on the generated share card."),
      r("Description", "The default meta description and footer text (50–200 characters)."),
      r("Editorial time zone", "Time zone for dates across the site.", "the site's time zone"),
      r("Date format", "29 Oct 2026, Oct 29, 2026, 29 October 2026 or 2026-10-29.", "29 Oct 2026"),
      r("Public contact email", "Shown on the contact page and, if enabled, in the footer."),
      r("Location", "Shown next to the contact email."),
      r("GitHub / LinkedIn / X / YouTube / Mastodon", "Social profile links (https only) used by the header, footer and author pages."),
      r("Comments", "Signed-in readers can comment and reply under posts. Each post can also lock or close its discussion.", "on"),
      r("New reader comments need approval", "Readers' comments appear after a moderator approves them. Authors' and admins' comments never wait.", "on"),
      r("Readers can edit their comments for", "0 means no time limit. Comments can always be deleted by their author.", "1440 min"),
      r("Reader sign-up", "New accounts by email or Google/GitHub. Existing users can always sign in.", "on"),
      r("Contact form", "Shown on /contact; messages arrive in Admin → Messages.", "on"),
      r("Public user manual", "Publishes this guide at /user-manual for everyone (documentation and defaults only, no site data).", "off"),
      r("Enable maintenance mode", "Readers see a maintenance page instead of the site; staff can still sign in.", "off"),
      r("Message for readers", "Shown on the maintenance page (up to 300 characters)."),
      r("Ask crawlers to retry after", "Sent to search engines as Retry-After (5–1440 minutes).", "30 min"),
    ],
  },
  {
    id: "appearance-branding",
    title: "Branding",
    rows: [
      r("Show the site name next to the logo", undefined, "on"),
      r("Logo (light theme)", "From the media library."),
      r("Logo (dark theme, optional)", "Used when the dark theme is on; empty uses the light logo."),
      r("Logo on phones (optional)", "A compact mark for narrow screens."),
      r("Favicon"),
      r("Apple touch icon", "The icon used when someone adds the site to an iPhone home screen."),
      r("Share image", "Default image for links shared on social networks."),
    ],
  },
  {
    id: "appearance-header",
    title: "Header",
    rows: [
      r("Preset", "4 starting layouts.", "standard"),
      r("Width", "Page width or full width.", "page width"),
      r("Height", "Compact, regular or tall.", "regular"),
      r("Navigation position", "After logo, centred or right."),
      r("Logo size", "Small, medium or large."),
      r("Keep the header visible while scrolling", undefined, "on"),
      r("Background", "Page, tinted, accent or an image (with mobile crop and overlay)."),
      r("Search", "Show the search button."),
      r("Light/dark switch", "Also controls the theme selector in the footer and mobile menu."),
      r("Account avatar and menu", "When hidden, readers can still sign in at /login; consider a menu link to it."),
      r("Social profile icons", "On wide screens only; profiles come from General."),
      r("Call-to-action button", "A highlighted button in the header."),
      r("Button text", "Up to 24 characters."),
      r("Button link", "A site path like /hire-me or an https link."),
      r("Show the announcement", "A bar above the header."),
      r("Text", "The announcement text (up to 200 characters)."),
      r("Link (optional)", "Where the announcement leads."),
      r("Style", "Neutral, accent or warning."),
      r("Readers can dismiss it", "Remembered in their browser until the text changes."),
    ],
  },
  {
    id: "appearance-navigation",
    title: "Navigation",
    rows: [
      r("Menus", "Up to 8 menus; choose which one is the header menu (1–8 top-level items)."),
      r("Menu items", "Link to pages, topics, sections, authors or https URLs; one level of sub-items; reorder with arrow buttons or drag-and-drop; indent/outdent; open in a new tab."),
      r("Previews", "Desktop and phone previews of the header menu."),
    ],
  },
  {
    id: "appearance-footer",
    title: "Footer",
    rows: [
      r("Preset", "Columns, simple or centred."),
      r("Alignment", "Left or centre."),
      r("Spacing", "Compact, regular or spacious."),
      r("Background", "Tinted, page, inverted or an image."),
      r("Heading / Links from / Menu", "Up to 4 columns, each with a heading and links from a menu or the topic list."),
      r("Logo and site name"),
      r("Description", "Empty uses the site description from General."),
      r("Social profile links"),
      r("RSS feed link"),
      r("Contact email and location", "From General → Contact."),
      r("Copyright line", "{year} becomes the current year and {site} the site name. Policy links and Privacy choices are always present."),
    ],
  },
  {
    id: "appearance-theme",
    title: "Typography & colours",
    rows: [
      r("Preset", "Default, Editorial, Midnight or High contrast."),
      r("Body font / Heading font", "Inter, IBM Plex Sans, Source Sans 3 or Source Serif 4."),
      r("Code font", "JetBrains Mono or IBM Plex Mono."),
      r("Heading weight", "Semibold, bold or extra bold."),
      r("Text size", "Default, larger or largest. Scales all text; form inputs never go below 16 px."),
      r("Article line height", "1.5–1.9."),
      r("Light and dark palettes", "Page, cards, text, secondary, meta, borders, accent and links, with live contrast ratios."),
      r("Page width", "64–88 rem."),
      r("Article reading width", "36–50 rem; about 70 characters per line at 43 rem."),
      r("Spacing between sections", "Compact, comfortable or spacious."),
      r("Corner radius", "None, small, medium or large."),
      r("Buttons and inputs", "Rounded, pill or square."),
      r("Default theme for new visitors", "Follow device, light or dark. Readers can still switch if the switch is shown.", "follow device"),
    ],
  },
  {
    id: "appearance-homepage",
    title: "Homepage",
    rows: [
      r("Sections", "Introduction, latest articles, hand-picked articles, topics, projects, editorial standards, author bio, call to action and a plain-text block: add, remove, reorder, hide or duplicate."),
      r("Section content", "Headings, text, links, images, layout, spacing and background; searchable pickers for articles and topics."),
      r("Author", "Which author the author-bio section shows."),
    ],
  },
  {
    id: "appearance-blog",
    title: "Blog & articles",
    rows: [
      r("Layout", "Grid or list."),
      r("Cards per row (wide screens)", "2 or 3."),
      r("Articles per page", "6–24."),
      r("Excerpt lines (0 hides it)", "0–4."),
      r("Cover image shape", "16:9, 3:2, 4:3, square or no cover."),
      r("Topic / Article type (News, Tutorial…) / Date / Reading time", "What each listing card shows."),
      r("Reading width", "Narrow, default or wide."),
      r("Body text size (desktop)", "16–19 px."),
      r("Breadcrumbs / Author in the byline / “Updated” date", "What an article page shows."),
      r("Author card after the article"),
      r("Show a table of contents"),
      r("Only for articles with at least", "2–8 headings."),
      r("On wide screens", "Table of contents in the right margin or above the article."),
      r("Related reading", "Related articles under each post."),
      r("How many", "1–6 related articles."),
      r("Share links", "Plain links to each network's share page: no third-party scripts."),
    ],
  },
  {
    id: "appearance-media",
    title: "Media",
    rows: [
      r("Image corners", "Square, small or medium."),
      r("Captions", "Centred or left."),
      r("Gallery columns", "2, 3 or 4."),
      r("Cloudflare R2 storage", "Status: uploads need storage configured (Settings → Storage)."),
    ],
  },
  {
    id: "appearance-seo",
    title: "SEO & integrations",
    rows: [
      r("Homepage title", "Up to 70 characters."),
      r("Title separator", "|, ·, — or -."),
      r("Search result preview", "How the homepage may look in Google."),
      r("Google Search Console verification", "Status; tokens are set in Advanced settings."),
      r("Bing Webmaster Tools verification", "Status; tokens are set in Advanced settings."),
      r("Google Analytics 4", "Status; loads in production only, with Consent Mode."),
      r("Google AdSense", "Status and number of ad slots."),
      r("ads.txt", "Whether /ads.txt is served."),
      r("Consent default", "Denied everywhere until consent, or only in the EEA, UK and Switzerland."),
      r("IndexNow", "Status; turned on in Integrations."),
      r("Cloudflare Turnstile", "Status; without it email sign-in and forms are unavailable."),
      r("Email", "Status; without it password resets are not sent."),
      r("Social sign-in", "Which providers are enabled."),
      r("Gemini image generation", "Status; configured in Integrations."),
    ],
  },
  {
    id: "appearance-hire-me",
    title: "Hire me",
    rows: [
      r("Show the Hire me page", "Off: /hire-me is not found and every call to action is hidden. Add the page to a menu in Navigation."),
      r("Availability", "Available, limited, or not taking new work (keeps the page but hides booking buttons and the article call to action)."),
      r("Availability note", "A short line under the availability."),
      r("Headline"),
      r("Introduction"),
      r("Reply time (shown under the form)"),
      r("Currency"),
      r("Intro call booking link", "Your Cal.com (or other https) booking page. Used by “Book an intro call” and by offers without their own link."),
      r("Open Cal.com links in a pop-up on the page", "Cal.com's scheduler loads only when a visitor clicks Book."),
      r("Self-hosted Cal.com address (optional)", "Only if you run Cal.com yourself. Bookings reach Admin → Bookings through a webhook (Advanced settings → Cal.com bookings)."),
      r("Offer paid calls", "Shown only while the page is on, you are taking work, both rates are set and the Razorpay keys are saved."),
      r("Title / Summary", "For the paid call and each offer."),
      r("Price per minute in India (INR)", "e.g. 50 → a 30-minute call costs ₹1,500."),
      r("Price per minute elsewhere (USD)", "e.g. 1.5 → a 30-minute call costs $45."),
      r("Shortest call / Longest call", "5–480 minutes."),
      r("Lengths offered in steps of", "5–120 minutes."),
      r("Booking link after payment (optional)", "Empty: the intro call link."),
      r("Offer this", "Show an offer (consulting, freelance, speaking, mentoring)."),
      r("Price from (0 = on request) / Per", "The offer's starting price and unit."),
      r("Booking link for this offer (optional)"),
      r("Show it", "The call to action under articles, with its Text."),
    ],
  },
  {
    id: "appearance-advanced",
    title: "Advanced (custom CSS)",
    rows: [r("Apply custom CSS", "Restricted CSS applied to the public site.", "off"), r("CSS", "Validated, up to 10,000 characters.")],
  },
];

const INTEGRATIONS: SettingsGroup[] = [
  {
    id: "integrations-social",
    area: "Integrations",
    title: "Social sign-in (Google, GitHub)",
    href: "/admin/integrations",
    rows: [
      r("Allow sign-in with Google / GitHub", "Show this provider on the sign-in page."),
      r("Authorized redirect / callback URL", "Read-only: register exactly this URL with the provider."),
      r("Client ID / Client secret", "From the provider's developer console. The secret is stored encrypted; leave it empty to keep it."),
      r("Use environment instead", "Drops the saved values and falls back to the deployment's environment variables."),
    ],
  },
  {
    id: "integrations-indexnow",
    area: "Integrations",
    title: "IndexNow",
    href: "/admin/integrations",
    rows: [
      r("Turn on IndexNow / Turn off", "Submits new and changed URLs to IndexNow search engines (Bing and others) in production.", "off"),
      r("Key file / New key", "Served by the site so search engines can confirm the key belongs to it; New key replaces it."),
      r("Submit all pages now", "Sends every public URL once, for example after turning it on."),
    ],
  },
  {
    id: "integrations-gemini",
    area: "Integrations",
    title: "Image generation (Google Gemini)",
    href: "/admin/integrations",
    rows: [
      r("API key", "Starts with AIza…; stored encrypted."),
      r("Image model (Fast)", "Model code from ai.google.dev; the default in the editor."),
      r("Pro model (optional)", "Higher quality, slower and dearer. Empty offers only Fast."),
      r("Default image size", "Preselected in the editor. Larger sizes cost more and take longer."),
      r("Largest size authors may pick", "Caps cost. Default: the larger of the default size and 2K."),
    ],
  },
  {
    id: "storage-r2",
    area: "Storage",
    title: "Media storage (Cloudflare R2)",
    href: "/admin/storage",
    rows: [
      r("Account ID", "Cloudflare dashboard → R2 → Account details (32 characters)."),
      r("Bucket / Access key ID / Secret access key", "An R2 API token scoped to this bucket (Object Read & Write). Leave the secret empty to keep it."),
      r("Public media URL (optional)", "A custom domain connected to the bucket; empty serves everything through the site."),
      r("API endpoint override (optional)", "Only for an EU/FedRAMP jurisdiction bucket."),
    ],
  },
  {
    id: "storage-email",
    area: "Email",
    title: "Email",
    href: "/admin/email",
    rows: [
      r("Email provider", "SMTP, Mailgun or Amazon SES. Only the selected provider sends; the others' settings are kept; no automatic failover."),
      r("Sender name / Sender email / Reply-to address"),
      r("SMTP: Host / Port / Encryption / Username / Password", "587 with STARTTLS or 465 with TLS from the start."),
      r("Mailgun: Sending domain / API region / API key", "The verified domain (e.g. mg.example.com), US or EU region, and a sending key for that domain."),
      r("Amazon SES: AWS region / Authentication", "Where the identity is verified; the server's AWS credentials (role / environment) or access keys stored here (limited to ses:SendEmail)."),
      r("Access key ID / Secret access key / Session token", "Only with stored access keys; the session token only for temporary credentials."),
      r("Send the test to", "Sends a test message with the saved settings to this address."),
    ],
  },
];

function mcpGroup(): SettingsGroup {
  return {
    id: "mcp-scopes",
    area: "MCP access",
    title: "MCP servers and scopes",
    description: "No scope can approve, publish, roll back or submit to search engines.",
    href: "/admin/automation/mcp",
    rows: [
      r("Admin server", "OAuth 2.1 with PKCE; switch ADMIN_MCP_ENABLED.", "off"),
      r("Public server", "Read-only, published articles only, no sign-in; switch PUBLIC_MCP_ENABLED.", "off"),
      ...Object.entries(SCOPES).map(([scope, help]) => ({ name: `Scope ${scope}`, key: scope, help })),
      r("Connected clients", "Each client with its scopes, who allowed it, when it was last used and its status; Revoke ends its access at once."),
    ],
  };
}

/** Admin → Invoices → Settings (lib/invoices.ts DEFAULT_INVOICE_SETTINGS; labels from app/admin/invoices/settings/page.tsx). */
const INVOICES: SettingsGroup = {
  id: "invoices",
  area: "Invoices",
  title: "Invoice settings",
  description: "Who invoices are from and what a new invoice starts with. An invoice that was already sent keeps the details it was sent with.",
  href: "/admin/invoices/settings",
  rows: [
    r("Business name", "Printed at the top of every invoice. Needed before an invoice can be sent.", "empty"),
    r("Business email", "Shown on the invoice and in the email as the address for questions.", "empty"),
    r("Business address", "One line per row, as it should appear on the invoice.", "empty"),
    r("Tax ID label / Tax ID", "Your registration (GSTIN, GST Reg. No., VAT, UEN) and its number, printed under the address.", "empty"),
    r("Default currency", "INR, USD, SGD, EUR, GBP, AUD, CAD or AED; each invoice can use another. Razorpay needs international payments switched on for anything but INR.", "USD"),
    r("Payment due (days)", "The due date of a new invoice is this many days after its date.", "14"),
    r("Default tax label / Default tax rate (%)", "The tax a new invoice starts with (GST, VAT), added on top of the lines. Empty means no tax.", "none"),
    r("Number prefix", "Invoices are numbered PREFIX-YEAR-0001 in order; the sequence starts again each year and no number is skipped or reused.", "INV"),
    r("Payment details and terms", "Printed at the end of every invoice: bank account for transfers, late-payment terms.", "empty"),
    r("Add a Razorpay payment link to every invoice", "The client gets a Pay button and the invoice is marked paid when Razorpay confirms the payment. Off: invoices are paid by bank transfer and marked paid by hand.", "on"),
  ],
};

export function settingsReference(): SettingsGroup[] {
  return [
    ...APPEARANCE.map((g) => ({ ...g, area: "Appearance & settings", href: `/admin/appearance?section=${g.id === "appearance-hire-me" ? "hireMe" : g.id.replace("appearance-", "")}` })),
    ...INTEGRATIONS,
    INVOICES,
    ...seoGroups(),
    mcpGroup(),
    ...advancedGroups(),
  ];
}

/** Every Automation & AI setting path (for tests: the reference must cover them all). */
export const seoSettingPaths = () => Object.keys(DEFAULT_SEO_SETTINGS).filter((k) => k !== "llmKey").flatMap((s) => leafPaths(getPath(DEFAULT_SEO_SETTINGS as unknown as Json, s) ?? {}, [s]));
