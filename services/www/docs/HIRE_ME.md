# Hire me (/hire-me)

Consulting, freelance projects, speaking/workshops and mentoring: one page, an enquiry form, booking links and a call to
action at the end of articles.

## Where things are edited

| What | Where |
| --- | --- |
| On/off, availability, headline, intro, reply time | Admin → Appearance → **Hire me** (draft → preview → publish, with history) |
| Offers: on/off, title, summary, **price** (0 = "On request"), unit, **Cal.com link** | Same panel, one section per offer |
| Currency, general intro-call link | Same panel, "Booking and pricing" |
| Article call to action (on/off, text) | Same panel, "Call to action in articles" |
| Résumé facts: experience, skills, certification, highlights, selected work | `src/config/hire-me-profile.ts` (code) |
| Header button or menu item | Admin → Appearance → Header (call-to-action button) or Navigation (add `/hire-me`) |

Publishing clears the page cache on every replica (the `settings` cache-bus kind), so a price or availability change
is live on the next request.

## Behaviour

- **Availability**: "Available" / "Limited" show booking buttons; "Not taking new work" keeps the page but hides
  booking buttons and the article call to action. Switching the page off makes `/hire-me` a 404, closes the form and
  removes it from the sitemap.
- **Booking**: Cal.com links open Cal.com's scheduler in a pop-up (see below); other https links open in a new tab.
  An offer without its own link uses the intro-call link; without either, only "Enquire" is shown, which scrolls to the
  form with that offer preselected (`#enquiry-<kind>`).
- **Prices**: whole numbers; 0 shows "On request". Set prices in Cal.com too if bookings are paid there.
- **Enquiries**: stored in `contact_message` with `kind` and `details` (migration `0023_contact_enquiry.sql`; rollback
  in `src/db/rollback/`), shown in Admin → Messages → **Enquiries**; admins get an email whose subject starts with
  `[Consulting]`, `[Freelance project]`… Same Turnstile and hourly limits as the contact form (3 per address, 100 in
  total, shared). Budget is asked only for consulting and freelance.
- **Analytics**: GA4 `generate_lead` events (`lead_action` = `enquiry_submitted` | `booking_clicked`, `lead_kind`,
  `lead_source` = path) through the consent-aware gtag; no personal data.
- **Caching**: `/hire-me` is ISR (300 s) like other public pages; the form reads the session and the hash in the
  browser, so the page stays static.
- **SEO**: in the sitemap while enabled; `ProfilePage` + `Person` JSON-LD with job title, skills, credential and offers.

## Cal.com integration

**Scheduling on the page.** With "Open Cal.com links in a pop-up" on (Admin → Appearance → Hire me, default on),
every Book button whose link is a cal.com link (or the self-hosted Cal.com address set there) opens Cal.com's own
scheduler over the page (`src/components/hire/BookingLink.tsx`, `calEmbedTarget()` in `src/lib/calcom.ts`):

- Cal.com's script (`https://app.cal.com/embed/embed.js`) is loaded on the **first click only**: readers who never book
  load nothing from Cal.com, and the cached page stays static.
- Month view, in the site's current light/dark theme.
- Cmd/Ctrl/Shift-click keeps the normal link (new tab). If the script is blocked or does not load within 8 s, the click
  goes to the booking page instead.
- GA4 `generate_lead`: `booking_clicked` on the click, `booking_completed` when Cal.com reports a booking
  (`bookingSuccessfulV2`), once per page load.
- Non-Cal.com links (Calendly, a form…) open in a new tab as before.

**Bookings in the admin.** Cal.com calls `POST /api/cal/webhook` for every booking event; Admin → **Bookings** lists them
(upcoming, past, cancelled, all) with the attendee, their time zone, event type, location and notes.

1. Cal.com → Settings → Developer → Webhooks → New: subscriber URL `https://jithendar.com/api/cal/webhook`; events
   *Booking created, rescheduled, cancelled, requested, rejected*; set a secret (16+ characters).
2. Admin → Advanced settings → **Cal.com bookings**: paste the same secret (stored encrypted).
3. Use Cal.com's "Ping test": it answers 200 ("Ignored.") once the secret matches.

Details: the raw body is verified with HMAC-SHA256 against `X-Cal-Signature-256` (constant-time compare); no secret →
503, bad signature → 401 (logged, nothing stored), > 256 KB → 413. Rows are keyed by Cal.com's booking uid
(`cal_booking`, migration `0024_cal_booking.sql`, rollback in `src/db/rollback/`), so repeated deliveries update the
same row; a reschedule stores the new booking and marks the old one "rescheduled"; a cancellation keeps the booking and
records the reason. "Remove from list" deletes the copy here (e.g. on a privacy request), not the booking in Cal.com.
Cal.com stays the source of truth: reschedule and cancel there.

## Paid calls (Razorpay)

Visitors choose a call length, pay **minutes × your per-minute rate**, then book a time.

- **Settings:** Admin → Appearance → Hire me → *Paid calls (Razorpay)*: on/off, title, summary, **price per minute in
  INR** (India) and **in USD** (everyone else), shortest/longest call and step (e.g. 15–120 min in 15s), and the booking
  link shown after payment (empty = the intro call link). Saving with paid calls on requires both rates and a link.
- **Keys:** Admin → Advanced settings → *Razorpay payments*: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` (sealed),
  `RAZORPAY_WEBHOOK_SECRET` (sealed). Same env names work as deployment variables.
- **Currency:** decided on the server from Cloudflare's `CF-IPCountry` header: `IN` → INR, anything else or missing →
  USD. Cloudflare overwrites the header on proxied requests, so a visitor cannot pick the cheaper rate. The header is
  read only when the request came through Cloudflare (`src/lib/client-ip.ts`, [DEPLOYMENT.md](DEPLOYMENT.md) "Client
  addresses"): a request sent straight to the origin with its own `CF-IPCountry` prices in USD.
- **Flow** (`src/lib/razorpay.ts`, `src/components/hire/PaidCall.tsx`, `src/app/_actions/payments.ts`): the cached page
  asks the server for the visitor's price on load → *Pay* runs Turnstile (skipped when signed in) and a rate limit
  (10/hour per IP, 5/hour per email), then the **server computes the amount** and creates a Razorpay Order
  (`POST /v1/orders`), stored in `hire_payment` → Razorpay Checkout (`checkout.razorpay.com/v1/checkout.js`, loaded on
  click only) → the server verifies Checkout's signature (HMAC-SHA256 of `order_id|payment_id` with the key secret),
  marks the order paid and returns the booking link with `duration`, `name`, `email` and
  `metadata[razorpayPaymentId]` filled in (read by Cal.com; give the Cal.com event type several lengths matching yours).
- **Webhook:** `POST /api/razorpay/webhook`, verified against `X-Razorpay-Signature` (HMAC of the raw body). Events
  `payment.captured` / `order.paid` mark the order paid if amount and currency match; `payment.failed` records the
  reason (never over a paid order). Covers visitors who close the tab before the Checkout callback.
- **Records:** Admin → Payments (paid / failed / started / all, with links to the Razorpay dashboard). Admins get one
  email per paid order. "Remove from list" deletes the record here only, not the payment, and never refunds.
  Migration `0026_hire_payment.sql`, rollback in `src/db/rollback/`.
- Payment details (card, UPI) never reach this site. Refunds and settlements: Razorpay dashboard.

## Deliberately not on the page

Phone number, personal email and a downloadable CV (public to every scraper; enquiries go through the form), and the
Terraform Associate certification (dated June 2026 on the résumé; re-add it in `hire-me-profile.ts` if current).

## Manual steps

1. Create the Cal.com event types (intro call, consulting…) and paste their links into the panel; add the webhook
   (see "Cal.com integration").
2. Set prices (or leave 0 for "On request") and publish.
3. Add `/hire-me` to the header (button or menu).
4. Live privacy policy: the page is stored in the database, so add the "Hire me enquiries" bullet from
   `content/pages/privacy-policy.mdx` in Admin → Pages → Privacy policy.
5. **Paid calls — requires manual configuration:** in Razorpay create API keys (start with `rzp_test_`), add the
   webhook `https://jithendar.com/api/razorpay/webhook` (events payment.captured, payment.failed, order.paid) with a
   secret, and paste all three in Advanced settings → Razorpay payments. **Enable International payments** on the
   Razorpay account or USD payments will fail. Set both rates in Appearance → Hire me → Paid calls, switch it on and
   publish. Test with Razorpay's test cards, then swap in `rzp_live_` keys (and a live-mode webhook).
6. Mention Razorpay as a payment processor in the live privacy policy (Admin → Pages → Privacy policy) and add
   payment/refund terms to the Terms page before taking live payments.
