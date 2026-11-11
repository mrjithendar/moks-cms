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
