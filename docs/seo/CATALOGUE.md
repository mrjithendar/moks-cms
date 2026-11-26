# Crews and flows: one catalogue (D-100)

AI & SEO → **Flows** and → **Crews** list every flow and every crew of the site: the SEO agent's own and the ones made
in the admin, with the same columns, filters and actions. There are no system, custom, content or SEO kinds. A crew or
flow has categories and tags for finding it, and nothing reads them to decide how it runs.

## What an admin can do with any crew or flow

| Action | Crews | Flows |
|---|---|---|
| Create | New crew: inputs (schema), agents, tasks, output (schema), model | New flow: inputs and steps (builder); New content flow: as before |
| Edit details | name, description, objective, categories, tags | name, description, categories, tags |
| Edit what it does | a spec crew: its spec (a new version each save); a code crew: prompts, models, tools and limits as versions (D-98) | a step flow: its steps (a new version each save); a content flow: its settings page; a code flow: duplicate it |
| Duplicate | any crew → a spec crew (a code crew is copied from the version it runs) | any flow → a step flow (a code flow becomes its first step); a content flow → a new content flow |
| Switch off / on | refused while a flow that is on runs it | a code flow switched off is refused by the agent, whoever starts it (person, schedule, flow, MCP, approval) |
| Delete / restore | refused while a flow runs it; kept and restorable | kept and restorable; a step flow's schedules are removed, a code flow's paused |
| Test | Test run: the crew in the editor, saved or not, once on given inputs | Test run: the flow in the editor, saved or not, as a dry run |
| History | the runs of the flows that run it | its runs, with each step's detail |

Every change is audit-logged as `crewai.crew.*`, `crewai.flow.*` or `crewai.category.*`.

## Filters

The same bar on both lists, all applied on the server (`lib/crewai/catalog.ts` `listCatalog`), all in the address so a
filtered list can be bookmarked or shared, and remembered per list for the browser tab:

`q` (name, description, key, tags; crews also objective) · `category` (any of, comma-separated) · `tag` (any of) ·
`status` (active = not deleted, enabled, disabled, deleted) · `recent` (created/updated in 7 or 30 days) · `run` (last
run succeeded/failed, running now, never run) · `sort` (name, updated, created, runs) and `dir` · `page`, `size`.
Category and tag counts are shown beside each choice; the result count, removable chips and Clear all are under the bar.

## Step flows (the agent's flow engine)

A flow made in the admin is a list of steps run in order by `custom_flow` (moks-seo-agent `app/flows/custom.py`):

| Step | Does |
|---|---|
| crew | runs any crew with inputs built from the flow's inputs and earlier steps; keeps its output (`save_as`). A code crew runs from its defaults plus its active version, with the tools that need no fixed article. An output schema (json + required keys) is checked. |
| flow | starts another flow as its own run (trigger "flow") and waits for it; keeps its outputs. Never an approval-only flow or the crew test run; refused when that flow is switched off. |
| condition | compares a value with a fixed one (contains, does not contain, equals, does not equal, is empty, is not empty, at least N characters); otherwise stop or skip the next step |
| draft | puts a draft in the review queue; a person approves it |

Every step can also have: an id, a name, `needs` (earlier steps that must have succeeded), `when` (a condition on the
step itself), `retry` (attempts 0–5, delay, backoff), `timeout_seconds` (5–3600 per attempt) and `on_failure` (stop,
continue, or fallback to a later step that runs only then). A flow whose steps failed with continue/fallback ends
`partial`. Values are templates: `{input.name}`, `{steps.name}`.

## Run logs

The agent records, per step (`seo_flow_run_steps.detail`): its id and kind, the flow version, attempts with their errors
and times, the condition and whether it held, the crew and its version (or the child flow and run), tokens and cost, and
metadata of what went in and out (type, size, keys, a short preview). The run page shows this as **Steps in detail**.
Log lines, step detail and transcripts are redacted before they are stored (passwords, keys, tokens, bearer and basic
credentials, JWTs, private keys, passwords in URLs; by field name and by shape). The service log on stderr is redacted
the same way.

Settings → SEO agent → Run history: **logs** (keep log lines; on), **stepIo** (keep input/output metadata; on),
transcripts and the retention days as before. Runs can be filtered by flow, category, crew, status, trigger and dates.

## The SEO agent module and the menu

`lib/modules.ts` is the module registry. The SEO agent is **installed** when SEO_AGENT_URL or an endpoint saved under
Settings → SEO agent → Connection is set, or discovery finds one that answers, and SEO_ORCHESTRATOR is not `legacy`; it
is **available** when it answers now. AI & SEO is drawn only while it is installed, and its pages show how to set it up
otherwise. `GET /api/admin/capabilities` returns `{modules: [{id, label, installed, available, version, reason,
menuGroups, setupHref}]}`.

## API

| Method and path | What |
|---|---|
| `GET /api/admin/crewai/catalog/{crews\|flows}?…filters` | one page, total and facets |
| `POST /api/admin/crewai/catalog/{crews\|flows}` | create from a spec (checked by the agent; 422 with issues) |
| `GET · PATCH · DELETE /api/admin/crewai/catalog/{crews\|flows}/{key}` | read (with versions), edit, delete |
| `POST /api/admin/crewai/catalog/{crews\|flows}/{key}` `{action}` | enable, disable (reason), restore, duplicate (key, label), restore-version (version) |
| `POST /api/admin/crewai/catalog/{crews\|flows}/validate` `{spec}` | the agent's check, nothing saved |
| `POST /api/admin/crewai/catalog/flows/test` `{flow \| draft, crewDraft?, inputs}` | a dry run of a saved step flow or of drafts |
| `GET · POST /api/admin/crewai/categories`, `PATCH · DELETE …/{slug}` | categories |
| `GET /api/admin/capabilities` | optional modules |

The agent reads: `GET /internal/seo-agent/custom-crews` and `/custom-flows` (spec rows that are on),
`/flow-switches` (code flows switched off or deleted), `/run-history/settings` (`transcripts`, `logs`, `step_io`).

## Migration 0041 and rolling out

Additive and re-runnable. It creates the four tables, seeds the categories and the agent's crews and flows (as the
console listed them), copies seo_custom_crews / seo_custom_flows (keys, specs, versions, switches, deletions and times)
and every content flow, and adds the trigger that keeps content flows in step with `news_jobs`. The old custom tables are
left in place until the copy has been checked on mk4; a later migration drops them. Roll back with
`src/db/rollback/0041_crewai_catalogue.down.sql` after deploying the previous web app.

Deploy the agent first (or together). The editors save input and output schemas, flow steps and step rules that an
older agent's check refuses (422, shown in the editor), and an older agent does not enforce flow switches (the admin
still refuses to start a switched-off flow from the console). A newer agent with an older web app gets 404 from
/flow-switches and keeps every flow on; specs saved before keep working with both.

## As files

Every crew and flow of the catalogue, with a code crew's agents and tasks as they run, is exported, versioned in the
site repository and restored by deployments: [CREWCONFIG.md](CREWCONFIG.md) (D-101).
