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
- **Booking**: plain links to Cal.com (or any https page), opened in a new tab: no embedded widget, no third-party
  script. An offer without its own link uses the intro-call link; without either, "Enquire" scrolls to the form with
  that offer preselected (`#enquiry-<kind>`).
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

## Deliberately not on the page

Phone number, personal email and a downloadable CV (public to every scraper; enquiries go through the form), and the
Terraform Associate certification (dated June 2026 on the résumé; re-add it in `hire-me-profile.ts` if current).

## Manual steps

1. Create the Cal.com event types (intro call, consulting…) and paste their links into the panel.
2. Set prices (or leave 0 for "On request") and publish.
3. Add `/hire-me` to the header (button or menu).
4. Live privacy policy: the page is stored in the database, so add the "Hire me enquiries" bullet from
   `content/pages/privacy-policy.mdx` in Admin → Pages → Privacy policy.
