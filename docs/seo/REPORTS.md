# Reports (CrewAI console and SEO-AI reports, D-102)

One report system: `seo_reports` holds the weekly and monthly SEO briefings (`request` null, unchanged since D-59) and
the reports made in the CrewAI console (`request` set: any dates, categories, crews, flows, sources). Both are listed,
downloaded and emailed the same way.

## Flow of a console report

```
admin ──POST /api/admin/crewai/reports──▶ seo_reports (queued) + job "report"            (returns at once: 202 {id})
web worker (lib/scheduler.ts) ─ job "report" ─▶ lib/reports/build.ts: every chosen category's figures, charts, tables,
    findings; each source's status; facts; untrusted error text ─▶ payload; HTML, JSON, CSV ─▶ R2
    ─▶ kickoff report_flow {report_id} in the SEO agent (retried while the agent is unreachable, 3 attempts;
       without the agent the report completes with every figure and no AI part / PDF, and says why)
seo-agent report_flow (moks-seo-agent app/flows/report.py):
    aggregate  ─ POST /internal/seo-agent/site-reports/{id}/data
    narrate    ─ Report crew, agent site_analyst (task "analyse", SiteAnalysis output)
    check      ─ check_analysis: numbers must be the report's figures; every item cites evidence ids; "confirmed"
                 needs direct evidence (a confirmed finding or a recorded error), else shown as probable
    store      ─ POST …/analysis
    render_pdf ─ app/reports_site_pdf.py (ReportLab) ─ POST …/pdf: the web app stores it, re-renders the HTML with the
                 analysis, records LLM cost from seo_llm_usage for the run, completes the report
    notify     ─ POST …/notify: queues the emails the report asked for (job "report_email")
```

The page polls `GET /api/admin/crewai/reports/{id}`; on every read, a report whose run failed, was cancelled, ended
without a PDF or ran for two hours is closed with the reason (`reconcileOpen`).

## Categories and sources

`lib/reports/catalog.ts`: 15 categories, each reading named sources; `collect.ts` has one builder per category (real
SQL over the site's tables for the range and the equal period before). Sources are probed before each report and when
the form opens: table missing → not available; never had a row → no data yet (for integrations such as Search
Console, GA4, run history or the agent's budget table: not available, because zero would be false); else available
with the rows in range. Crews and flows come from the catalogue and the run history. Costs are `seo_llm_usage.cost_usd`
as the agent recorded them; a call with tokens and no cost is reported as unknown cost. Crews are attributed by prompt
family (`PROMPT_VERSION` without its version) mapped through the agent's `GET /crews`. The LLM budget is read from the
agent (`GET /llm-budget`), else its table, else reported as unknown.

## Files and access

- R2 keys: `jithendar/www/reports/{tenant}/{site}/{yyyy}/{mm}/{report_id}/report.{pdf,html,json,csv}`, private
  (`Cache-Control: private, no-store`). Tenant: `MOKS_TENANT_ID` (optional), else the site; site: `site.json` host.
- Downloads: `GET /api/admin/crewai/reports/{id}/download?format=` → 302 to a 5-minute presigned URL. Preview:
  `…/preview` serves the HTML with `default-src 'none'` and `sandbox`. No public or permanent URL exists.
- Every route is admin-only (`seoRoute`): same-origin mutations, rate limits, audit (`report.generate`, `.download`,
  `.email`, `.cancel`, `.retry`, `.regenerate`, `.delete`). Every query filters on this site; another site's report
  answers 404.
- Rendering escapes every value (lib/reports/render.ts; ReportLab paragraphs in the agent); no script or external
  resource; CSV cells starting with = + - @ are prefixed.
- The analyst gets data in `<data>` blocks marked untrusted; error text is redacted (keys, tokens, credentials in
  URLs) before it is stored or sent.

## Email

`lib/reports/email.ts`: one `seo_report_deliveries` row per recipient, job `report_email`: queued → sent, or retried
(provider error; 3 attempts with backoff) → failed with the reason. The PDF is attached when it fits the provider's
limit (SES 40 MB, Mailgun 25 MB, SMTP 10 MB; lower with Settings → Reports → largest PDF), else a signed link valid for
`linkHours` (0 = 7 days, R2's maximum). `sendRichMail` (lib/mail.ts) sends HTML + attachments through SMTP, Mailgun or
SES (raw MIME) and throws, unlike `sendMail`.

## Settings (AI & SEO → Settings → Reports)

`subjectTemplate` ({title}, {period}, {site}), `introText`, `attachPdf`, `attachMaxMb` (0 = provider limit),
`linkHours` (0 = 7 days), `keepDays` (0 = kept; else the daily retention deletes the report and its files).

## Requires configuration

- Cloudflare R2 (Settings → Storage): without it reports are viewable in the admin but no file is stored.
- Email (Settings → Email): without it nothing is sent; the form and the dialog say so.
- The SEO agent with this PR's report_flow (moks-seo-agent): without it, no AI analysis and no PDF.
