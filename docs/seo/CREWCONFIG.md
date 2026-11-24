# CrewAI configuration as files (crewconfig/)

The whole CrewAI setup of a site — every crew with its agents and tasks, every flow, skill, schedule, content source
and category, and, read-only, the tools, prompt guardrails and model providers they run with — as plain files in the
site's own repository (`crewconfig/`). Git is where it is reviewed and versioned; a deployment restores it; the admin
edits it, exports to it, imports from it, and shows whether the running site still matches it. Decision: D-101.

Code: `src/lib/crewai/bundle/` (model.ts, files.ts, runtime.ts, import.ts, check.ts, sync.ts, repo.ts, zip.ts,
service.ts). Admin: **AI & SEO → Configuration** (`/admin/crewai/config`). Migration 0042 (`crewai_config_syncs`).

## Why the export used to be empty

The format 1 export (`moks-crewai-config`, Import / export before D-101) wrote three lists and chose what went in them
from database rows only:

- `crews`: the **active version** of each crew (`seo_crew_configs`). A crew that runs on its code defaults has no
  version, so a site that never edited a crew exported `crews: []` although five crews run.
- `skills`: only skills an admin **added or edited** (`!builtin || edited`). The shipped skills were left out, so a site
  using them as shipped exported `skills: []`.
- flows, agents, tasks, spec crews and flows, content flows, sources, categories and tools were not exported at all.

Format 2 discovers everything at export time instead (never from a list in the code): it first adds what the SEO agent
reports and the catalogue lacks (as the catalogue pages do), then exports every catalogue row as it runs.

## The bundle

```
crewconfig/
├── manifest.json               format, generator, source, inventory, dependencies, checksums, what is not covered
├── README.md                   generated: layout and editing rules
├── categories/categories.yaml
├── crews/<key>.yaml            definition code|spec, agents and tasks (in order), spec crews' inputs/output/model,
│                               code crews' read-only `code` block (prompt version, defaults hash, allowed tools)
├── agents/<crew>/<agent>.md    front matter: role, goal, tools, model, max_tokens, max_iter; body: backstory
├── tasks/<crew>/<task>.md      front matter: agent, label, expected_output, context; body: the instructions
│                               (prompt template with {placeholders}); code tasks add read-only contract/variables
├── flows/<key>.yaml            definition code|spec|content; spec flows' steps (needs, when, retry, timeout,
│                               on_failure); content flows' settings with sources by URL; code flows' read-only runtime
├── skills/<name>/SKILL.md      front matter: name, description, agents, tags, enabled, builtin; body: instructions
├── schedules/schedules.yaml
├── sources/sources.yaml        content sources (matched by URL across sites)
├── tools/tools.yaml            read-only: the agent's tools, which crews and agents hold them, which spec crews may
├── prompts/guardrails.yaml     read-only: the rules the agent's code puts in every system prompt
├── providers/providers.yaml    read-only: providers and models, `key_ref` says where the key is (never the key)
└── schemas/*.schema.json       JSON Schema of every file kind, generated from the zod schemas in model.ts
```

Field names are CrewAI's (`role`, `goal`, `backstory`, `expected_output`, `context`, `tools`), snake_case throughout.
A content flow's key (`content_<12 hex>`) comes from its settings' id; an import elsewhere creates the settings with an
id that gives the same key back, so the same flow stays the same item on every site.

**Not covered** (listed in `manifest.json` → `unsupported`, and on the Overview): content writing and image profiles
(content flows name them by key; an import refuses a flow whose profile the site lacks), provider keys, budgets and
the agent's settings (credentials and limits), run history. The three runner flows (`custom_flow`, `news_job_flow`,
`crew_test_flow`) are not items: every spec flow, content flow and crew test is exported under its own key. Deleted
crews and flows are reported as skipped (they are restorable in the admin).

**Code vs configuration.** Crews and flows defined in code keep their structure in the SEO agent: a bundle carries what
can change (prompts, models, tools from the crew's allowlist, limits; a flow's name, categories, tags and switch). An
import saves a code crew's agents and tasks as a crew version (only what differs from the code, normalised by the
agent's `POST /crews/{crew}/validate`); adding or removing one of its agents or tasks is refused. Spec crews and flows
are complete in the bundle. Nothing in a bundle is ever executed: YAML is read with the core schema (no tags, no merge
keys, an alias cap, unique keys), every item goes through its zod schema, and the agent checks every crew and flow spec,
crew version and schedule input before it is saved.

**No secrets.** Every string of an export is scanned (API keys, tokens, private keys, credentials in URLs); a match is
replaced by `[redacted]` and reported with its item and field.

## Import

`lib/crewai/bundle/import.ts`, one entry point for the admin, the repository and deployments:

1. **Read**: format 2 files, or a format 1 file (still imported: its schedules, crew versions as full crews, skills).
2. **Validate**: file paths (no `..`), sizes, YAML/front matter, each item's schema, duplicate ids, the manifest (a newer
   format is refused; a stale checksum is a warning: a person edited a file).
3. **References**: a crew lists exactly the agents and tasks with files, a task's agent and context, flows → crews and
   step flows, schedules → schedulable flows and spec flows, categories, content sources, code-crew structure and tool
   allowlists (check.ts, then the site and the agent).
4. **Plan** against what runs (`exportRuntime`) and the **baseline** (the checksums of the last sync): `create`,
   `update` (unchanged here since the last sync), `conflict` (changed here since the last sync, or no sync yet),
   `unchanged`, `remove` (only with `prune`), `keep`, `error`. Changes are listed per field.
5. **Agent checks** for what would be saved; spec crews and flows are replaced by the agent's normalised form, so the
   plan compares, and the import verifies, what will be stored.
6. **Apply** in one transaction (every write function takes the caller's transaction, audit entries included), in
   dependency order: categories, sources, crews (switched on before the flows that run them), skills, flows, schedules,
   switch-offs (flows before crews), removals.
7. **Verify** inside the transaction: the configuration is exported again and every applied item must equal the
   bundle's; any difference rolls everything back.
8. **Record** (`crewai_config_syncs`): source, revision, plan, counts, the new baseline, and a snapshot of what was
   there before (only when something changed). Audit-logged (`crewai.config.import`).

Options: `policy` for conflicts — `skip` (keep this site's version; the default for deployments and the API),
`overwrite` (the default in the admin, which shows the plan first), `fail`; `prune`; `kinds`; `only` (individual items,
`crews:editorial` includes its agents and tasks); `activate` (crew versions); `allowPartial` (apply the rest when an item
is refused; otherwise any refusal changes nothing). A crew is one unit with its agents and tasks: one of them held back
holds the crew back. Never removed, even with `prune`: code crews and flows and their agents and tasks, shipped skills,
built-in schedules. Imports are idempotent: the same bundle again plans `unchanged` everywhere and writes nothing.

**Rollback**: History → Roll back re-imports the snapshot with `overwrite` and `prune` (what the import added is removed,
crews and flows restorably), recorded as a new import.

## Sync, drift and the repository

- **Baseline**: after an applied import, or a write to Git in commit mode, the checksums both sides agree on. A change
  made on the admin pages since then is **drift** (Overview and the console: "N changed here since"), and a conflict
  for the next import, which keeps it under `skip`.
- **Repository** (Settings tab): GitHub repository, branch, folder, `commit` or `pull_request`, and a fine-grained token
  (Contents and Pull requests, read and write, on that one repository), sealed with `SETTINGS_ENCRYPTION_KEY`, or the
  deployment's `CREWAI_CONFIG_GITHUB_TOKEN` (also `CREWAI_CONFIG_REPO`, `CREWAI_CONFIG_BRANCH`, `CREWAI_CONFIG_PATH`,
  `CREWAI_CONFIG_MODE`). Reads use the tree API and one GraphQL request per 100 files.
- **Editing** (Repository tab): browse and search, the editor (YAML, Markdown front matter, JSON), Validate (the file in
  the context of the whole folder), Save (one commit or pull request; the author is the admin; the manifest, README and
  schemas are rewritten), Delete (with confirmation), History, Compare (a version against the editor), Revert (a new
  commit), New crew / flow / skill from templates. A save names the commit and each file's blob it started from: a file
  changed in Git meanwhile is a 409, and the branch moves only fast-forward. A change that would not read is refused
  before anything is written.
- **Write to Git** (Overview): the running configuration as one commit or pull request; refused while the export is
  incomplete (the agent down), so a partial export never deletes files. In pull request mode it becomes the baseline
  only when the merged folder is imported.
- **Import from Git** (Overview): a plan of the branch head, then applied with the commit as its revision.

## Deployments (the site repository)

The site repository's `deploy-kubernetes.yml` runs a `crewconfig` job after the deploy job succeeded (rollouts
finished, smoke test passed): it checks `crewconfig/` (`scripts/crewconfig.py check`), waits for
`GET /api/v1/crewai/config/status` (database, every migration applied, the agent), plans, applies with `policy: skip` and
the commit as revision, and fails the job on a refusal or failure (nothing changed: the import is one transaction).
Its own `crewconfig.yml` does the same for a push to master that changes only `crewconfig/`, and checks pull requests
(a dry run against the site when the key is set). The key is an admin's API key with `crewai:read` and `crewai:import`
(Admin → API keys), secret `JITHENDAR_CREWAI_KEY`.

API (API key): `GET /api/v1/crewai/config` (crewai:read, the bundle and its report), `GET /api/v1/crewai/config/status`
(crewai:read), `POST /api/v1/crewai/config/import` (crewai:import, `{files, dryRun, policy, prune, kinds, only,
allowPartial, source: deploy|api, revision, ref, url}`). Admin (session): `/api/admin/crewai/config` (GET bundle,
`?format=zip`; POST import), `/status`, `/syncs`, `/syncs/{id}/rollback`, `/repo` (settings, `?compare=1`, test),
`/repo/files`, `/repo/file`, `/repo/history`, `/repo/revert`, `/repo/export`, `/repo/import`, `/repo/validate`.

## Tests

`tests/crewai-config-bundle.test.ts` (against the agent's real `GET /config-catalogue`, captured in
`tests/fixtures/seo-agent/config-catalogue.json`): completeness against the catalogue (every crew, agent, task, flow,
tool, skill, schedule), files round trip, manifest and schemas, agent down, secret redaction, no-op re-import, edits,
idempotency, conflicts and policies, drift, refusals that change nothing, partial import, broken files and references,
selection and removal, rollback, content flows across sites, format 1, the repository (fake GitHub: export, compare,
commits, conflicts, history, revert, pull requests, incomplete export), API keys and roles.
`tests/crewai-console-config.test.ts`: the admin route and format 1 end to end. moks-seo-agent
`tests/test_config_catalogue.py`: the catalogue lists every registered crew, flow and tool, and a crew's full
definition validates as no change.
