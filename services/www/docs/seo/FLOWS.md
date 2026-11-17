# SEO v4: CrewAI Flows (the only agent and job engine)

Every AI workflow and every scheduled SEO job runs as a **CrewAI Flow** (crewai 1.15.30) in `services/seo-agent`.
Flows orchestrate; **Crews** do the multi-agent steps ([CREWS.md](CREWS.md)); plain Python steps do the data work
(sync, scoring, crawling) without a model. There is no other workflow engine: no LangGraph, LangChain, n8n, Airflow,
Temporal or Celery. Kubernetes CronJobs only **trigger** flows. The MCP servers ([MCP.md](MCP.md)) are an interface
onto the same service functions and the same kickoff, never a second orchestrator.

Related: [CREWS.md](CREWS.md) · [MCP.md](MCP.md) · [RAG.md](RAG.md) · [COSTS.md](COSTS.md) ·
[MANUAL_SETUP.md](MANUAL_SETUP.md#v4-crewai-flows-mcp-report-pdfs) · [DECISIONS.md](DECISIONS.md) D-54 onward.

## Architecture

```mermaid
flowchart LR
  subgraph k8s["namespace jithendar"]
    cron["CronJobs seo-flow-*\n(python -m app.trigger <flow>)"]
    subgraph web["jithendar-com pods (Next.js)"]
      ui["/admin/review UI\n(approve = only here)"]
      cb[":9465 callback API\n(v1/v2 functions)"]
      oauth["OAuth AS for /mcp/admin"]
    end
    subgraph agent["seo-agent pod"]
      api[":8080 internal API\n/flows/*, /review/*, /ask"]
      runner["FlowRunner\n(locks, seo_flow_runs)"]
      flows["CrewAI Flows"]
      crews["Crews: optimization ·\neditorial · report"]
      mcp[":8090 MCP edge\n/mcp/public · /mcp/admin"]
      svc["app/services\n(shared functions)"]
    end
  end
  kong["Kong (/mcp/*)"] --> mcp
  pg[("PostgreSQL\nseo_flow_runs · drafts · usage ·\nseo_article_chunks (pgvector) ·\nMCP tokens (hashes)")]
  r2[("Cloudflare R2\nreport PDFs")]
  claude["Anthropic API"]
  cron -- "kickoff (service token)" --> api
  ui -- "kickoff / decision (service token)" --> api
  api --> runner --> flows --> crews
  mcp --> svc --> runner
  api --> svc
  flows -- "callbacks" --> cb
  cb --> r2
  crews --> claude
  runner --> pg
  oauth --> pg
  mcp -. "token lookup" .-> pg
```

## Trigger table

| Flow | Trigger | Steps (`@start` → `@listen` / `@router`) | Ends at |
|---|---|---|---|
| `gsc_sync_flow` | CronJob daily 06:10 UTC; "Sync now" | run_job (v1 GSC sync) → record_stats | done |
| `ga4_sync_flow` | CronJob daily 06:20 UTC; "Sync now" | run_job (v1 GA4 sync) → record_stats | done |
| `tech_audit_flow` | CronJob Mon 03:00; MCP | run_job (v1 crawler + audit) → record_stats | done |
| `ask_gaps_flow` | CronJob Mon 04:30 | cluster (unanswered questions → "Asked on site" content gaps) | done |
| `weekly_recommendations_flow` | CronJob Mon 07:00; "Run now" | prepare (freshness → rules → scoring → top N without an open draft → reserve drafts) → fan_out (≤ 2 `optimize_article_flow` at once) | done |
| `optimize_article_flow` | weekly flow; "Draft/Fix with Claude"; keyword actions; regenerate; MCP | fetch_context → analyze → draft (**Optimization Crew**) → validate_draft → router: ok → save_draft · retry once → draft · fail → failed | **draft awaiting review** |
| `internal_linking_flow` | CronJob Mon 09:00; MCP | candidates (pgvector + shared queries) → plan_and_merge (v2 planner, every limit in code) | drafts updated |
| `new_article_flow` | approved calendar idea; regenerate; MCP | load_brief → draft (**Editorial Crew**) → validate_draft → router: ok → save_draft · retry once · fail | **draft awaiting review** |
| `publish_flow` | **only a human approval** (`POST /review/{id}/decision`) | apply_changes → cms_publish → verify_live → router: passed → submit_search → reindex → schedule_measure · failed → offer_rollback | done |
| `reindex_flow` | CronJob Sun 03:17; after each publish (inside publish_flow) | chunk_and_embed (incremental by content hash) | done |
| `seo_ml_flow` (v5) | CronJob `seo-flow-ml` Sun 04:47; ML models → Run now | decay → query_clusters → intent → priority → related → rag_eval → finish (each step independent; the run fails if any failed) | done ([ML.md](ML.md)) |
| `report_flow` | CronJob Mon 08:00 (weekly) and the 2nd 08:00 (monthly); "Generate"; MCP | aggregate → narrate (**Report Crew**) → router check: store · mismatch → render_pdf (R2) → notify | done |
| `promotion_flow` | CronJob `seo-flow-promotion` daily 07:40 UTC; Promotion → "Find opportunities" / "Re-score and draft posts" | collect (web: Reddit read, channel scores) → draft (**Promotion Crew** copywriter) → save | **drafts awaiting a person** ([PROMOTION.md](PROMOTION.md)) |
| `content_ideas_flow` | CronJob `seo-flow-content-ideas` Tue 05:20 UTC; Promotion → "Suggest content ideas" | collect_signals (web: Search Console demand, Reddit threads) → ideate (**Promotion Crew** strategist) → save (evidence verified by the web app) | **ideas awaiting a person** |

Schedules are configuration in `kubernetes/seo-agent-60-flow-triggers.yaml` (the two promotion flows: `seo-agent-62-promotion-triggers.yaml`): change a `schedule:` (or
`kubectl patch cronjob seo-flow-… -p '{"spec":{"schedule":"…"}}'`) without a code change. "Run now" buttons in the admin
and the MCP `kickoff_flow` tool call the same `POST /flows/{name}/kickoff` endpoint as the CronJobs.

## The flows

All diagrams show method names; router labels carry a `to_` prefix in code (CrewAI 1.15 refuses a label equal to a
method name). Network steps retry transient errors only (connection, timeout, 429, 5xx) three times with backoff.

### optimize_article_flow

```mermaid
flowchart TD
  S([start]) --> FC[fetch_context]
  FC -->|not published| SK([skip: no_changes])
  FC --> AN[analyze]
  AN -->|nothing eligible| SK
  AN -->|links only| VA[validate_draft]
  AN -->|model work| DR["draft (Optimization Crew)"]
  DR -->|budget| PB([paused_budget])
  DR --> VA
  VA -->|errors, first try| DR
  VA -->|errors after retry| GF([failed: generation_failed])
  VA -->|no changes| NC([superseded])
  VA -->|ok| SD[save_draft] --> RR([draft_ready: awaiting review])
```

`validate_draft` runs the web app's v2 validators (block exists, `before` matches exactly once, code untouched, no
invented URLs, lengths…) and adds the planner's internal links. The technical reviewer's `needs_fact_check` items become
flags the reviewer sees. `save_draft` is the only write: the change set on the draft, every change `pending`.

### new_article_flow

```mermaid
flowchart TD
  S([start]) --> LB[load_brief] --> DR["draft (Editorial Crew)"]
  DR -->|budget| PB([paused_budget])
  DR --> VA[validate_draft]
  VA -->|errors, first try| DR
  VA -->|errors after retry| GF([generation_failed])
  VA -->|ok, or crew result incomplete| SD[save_draft] --> RR([draft_ready])
```

An incomplete crew result is still saved (marked incomplete, approval blocked by its error flags): a partial draft is
more useful to the reviewer than nothing.

### publish_flow

```mermaid
flowchart TD
  D(["POST /review/{id}/decision\n(approve, approval_id from the web UI)"]) --> AC[apply_changes]
  AC -->|no accepted changes / bad edits| ST([publish_failed])
  AC --> CP["cms_publish\n(web publishWithApproval)"]
  CP -->|approval missing, used, expired, changed| ST
  CP -->|"response lost after the commit: replayed (Idempotency-Key)\nor draft already published by this approval"| VL
  CP --> VL["verify_live\n(3 attempts: 40 s, 30 s, 60 s)"]
  VL -->|failed| RB(["offer_rollback: alert + one-click rollback\n(verify_failed, nothing submitted)"])
  VL -->|passed| SU["submit_search\n(IndexNow, sitemap, URL Inspection later)"] --> RI[reindex] --> SM[schedule_measure] --> P([published])
```

### weekly_recommendations_flow, internal_linking_flow, report_flow

```mermaid
flowchart LR
  subgraph weekly
    P1[prepare] --> F1["fan_out: optimize_article_flow × N\n(≤ 2 at once, each ends at its draft)"]
  end
  subgraph linking
    C2[candidates] --> M2["plan_and_merge\n(v2 planner limits)"]
  end
  subgraph report
    A3[aggregate] --> N3["narrate (Report Crew)"] --> K3{check}
    K3 -->|every number matches| S3[store] --> R3[render_pdf → R2]
    K3 -->|mismatch| X3["mismatch (run failed)"] --> R3
    R3 --> T3["notify (skipped after a mismatch)"]
  end
```

The job flows (`gsc_sync_flow`, `ga4_sync_flow`, `tech_audit_flow`) are `run_job → record_stats` around the v1 job
runner, which keeps its own lease, `seo_sync_jobs` row and metrics. A scheduled run passes a dated slot; the web app
skips a job type whose scheduled run for that slot already exists, so the CronJob and (before switching) the in-process
scheduler can never both run it.

## The human gate: split-flow approval (D-56)

```mermaid
sequenceDiagram
  participant F as optimize/new_article_flow
  participant W as Web review UI (admin)
  participant A as seo-agent /review/{id}/decision
  participant P as publish_flow
  F->>W: save_draft (status ready_for_review), flow ends
  Note over W: review: accept/reject/edit each change (hours or days later)
  W->>W: Approve → preflight → seo_draft_approvals row (approver, accepted ids, 7-day expiry, single use)
  W->>A: decision approve {approval_id, accepted_change_ids, edits}
  A->>P: kickoff publish_flow (triggered_by=approval)
  P->>W: cms_publish → publishWithApproval re-checks everything, consumes the approval
  W-->>A: (reject) rejectDraft + decision reject → drafting runs cancelled
  W-->>A: (regenerate) decision regenerate → new drafting run with the feedback
```

Nothing waits in memory: a drafting flow **ends** at `ready_for_review` with its final state in `seo_flow_runs`.
Approval starts a new flow. This survives restarts and redeploys. CrewAI's `@human_feedback` exists in 1.15 but holds a
flow open (persisted) until feedback arrives; the split pattern was chosen instead because the approval must be recorded
and re-checked by the web app (v3 D-43), and nothing should depend on a paused run.

Guarantees (all tested):
- No drafting flow, crew, tool or MCP module calls the web app's publish/verify/submit callbacks; only
  `flows/publish.py` does (static test over the source).
- `publish_flow` is refused by the run manager for every trigger except `approval`, which only the decision endpoint sets
  (`POST /flows/publish_flow/kickoff` → 403; MCP `kickoff_flow("publish_flow")` → refused).
- The web app publishes only for an unused, unexpired approval for this draft with exactly these accepted change ids, an
  approver who is still an admin, and edits equal to what the review UI stored.

## State and persistence

Typed Pydantic state per flow (`app/state.py`); every input is validated against a strict model first (extra fields
refused, bounded sizes, UUID patterns).

| State | Fields (besides `id`, `triggered_by`, `outcome`, `errors`, `cost_usd`, `tokens`) |
|---|---|
| `JobState` | job_type, slot, result |
| `WeeklyState` | limit, prepared, children |
| `OptimizeState` | draft_id, article_id, recommendation_ids, extra, trigger, feedback (reviewer), validator_feedback (automatic retry), context, related, plan, change_set, crew, changes, validation_report, attempts |
| `LinkingState` | article_ids, candidates, results |
| `NewArticleState` | draft_id, calendar_id, article_id, feedback (reviewer), validator_feedback (automatic retry), brief, document, crew, changes, validation_report, attempts |
| `PublishState` | draft_id, article_id, approval_id, accepted_change_ids, edits, actor, publish_result, verification, submission_results, reindex, measurement |
| `ReindexState` | article_ids, full, result |
| `AskGapsState` | result |
| `ReportState` | period, report_id, numbers, narrative, check, crew, pdf, notified |
| `PromotionState` | article_id, limit, reddit, articles, drafts, results, result |
| `ContentIdeasState` | reddit, signals, ideas, crew, result |

`seo_flow_runs` (web migration 0016): run_id, flow_name, target_id, draft_id, status (queued · running · succeeded ·
failed · cancelled · paused_budget), current_step, state_json, inputs, outputs, error, tokens, cost_usd, started_at,
finished_at, updated_at, triggered_by (cron · manual · approval · flow · mcp), correlation_id, actor.

- **Persistence:** `PgFlowPersistence` implements CrewAI's `FlowPersistence` and writes the state, step, tokens and cost
  into the run's row after every step (CrewAI calls it synchronously; a 2-connection sync pool). CrewAI's default SQLite
  persistence is never used: every flow class is decorated with `@persist(INSTANCE_ONLY)`, a backend that refuses to
  work, and each instance gets the Postgres one. Flows also skip CrewAI's auto-created memory (`_skip_auto_memory`; LanceDB is installed since D-91, but a flow gets no memory of its own).
- **One active run per flow + target:** a partial unique index (`flow_name, target_id` where queued/running) refuses a
  second row; a Postgres **session advisory lock** on a dedicated connection is held for the whole run (a dead pod's
  connection closes and releases it). A second kickoff returns the existing run (`existing: true`).
- **Failures:** a step that raises marks the run `failed` with the error. A rerun starts from the beginning; steps are
  idempotent (upserts, one open draft per article, single-use approvals). On start-up, runs the previous process left
  queued/running are failed ("interrupted by a restart") and their drafts set to "regenerate".
- **Wall clock:** `SEO_FLOW_TIMEOUT_SECONDS` (1800) per run; crews have their own shorter limit. A cancelled or timed-out
  run also stops its crew: the crew's worker thread makes no further model call (CREWS.md "Cancellation").
- **Publish retries:** `cms_publish` sends the approval id as `Idempotency-Key`. If a publish commits and its response is
  lost (timeout, 5xx), the retry gets the earlier success back from `publishWithApproval` (`replayed: true`) instead of a
  403 for the used approval. Against a web app without that, a non-transient error after a transient one makes the flow
  read the draft (`GET /drafts/{id}`): `published` by this approval (`publishedApprovalId`) counts as success.

## Scheduling

One CronJob per scheduled flow (`kubernetes/seo-agent-60-flow-triggers.yaml`): `concurrencyPolicy: Forbid`,
`startingDeadlineSeconds: 3600`, `successfulJobsHistoryLimit: 2`, `failedJobsHistoryLimit: 3`, `activeDeadlineSeconds:
600`. The container runs `python -m app.trigger <flow> [json inputs]`: one authenticated `POST /flows/{flow}/kickoff`
(`triggered_by=cron`), then `/quitquitquit` so the Istio sidecar exits. With `SEO_ORCHESTRATOR=crewai` the web app's
in-process scheduler skips these job types (`FLOW_OWNED_JOBS`): gsc_sync, ga4_sync, technical_scan, recommendations,
drafts_weekly, drafts_poll, report_weekly, report_monthly. Keywords refresh, retention, outcomes and the digest stay in
the web worker (they are not AI workflows and the brief lists no flow for them).

## Internal API (seo-agent :8080, bearer `SEO_AGENT_TOKEN`)

```
POST /flows/{flow_name}/kickoff     {inputs, triggered_by: cron|manual, actor?} → {run_id, status, existing}
GET  /flows/runs                    ?flow=&status=&draft_id=&limit=
GET  /flows/runs/{run_id}           status, current_step, outcome, outputs, error, tokens, cost (+ state)
POST /flows/runs/{run_id}/cancel
POST /review/{draft_id}/decision    {approve|reject|regenerate, approval_id, accepted_change_ids, edits, feedback}
POST /ask                           Ask the Blog (proxied by the web app's rate-limited /api/ask)
GET  /budget · /healthz · /readyz · /metrics
```

The web app's `/api/admin/seo/*` routes proxy to these through `src/lib/seo-agent/client.ts` and `orchestrate.ts`; the v2
review UI is unchanged (it reads the latest `seo_flow_runs` row for a draft).

## Operations

- <a id="failed-runs"></a>**Failed runs:** Sync history and MCP `list_flow_runs(status=failed)` show the error; the
  state is kept in `state_json`. Fix the cause and rerun (the "Run now" button, the CronJob, or for drafts
  "Regenerate"). Alert `SeoFlowRepeatedFailures`.
- **Stale flows:** `SeoFlowStale` fires when a flow hasn't succeeded within twice its schedule (from
  `seo_flow_last_success_timestamp_seconds`). Check `kubectl -n jithendar get cronjob seo-flow-…` and the last runs.
- **Restarts:** Deployment strategy `Recreate` (never two pods). Interrupted runs are failed on start; rerun them.
- **Cancel:** the review page's run strip or `POST /api/admin/seo/agent/runs/{draftId}/cancel`.
- **Metrics:** `seo_flow_runs_total{flow,status}`, `seo_flow_duration_seconds{flow}`, `seo_flow_step_duration_seconds{flow,step}`,
  `seo_crew_runs_total{crew,status}`, `seo_llm_tokens_total{model,purpose}`, `seo_llm_cost_usd_total{purpose}`,
  `seo_drafts_awaiting_review`, `seo_flow_last_success_timestamp_seconds{flow}`, `seo_ask_requests_total{outcome}`,
  `seo_embeddings_reindex_chunks_total`, `seo_mcp_requests_total{server,tool,status}`, `seo_mcp_auth_failures_total{server}`,
  `seo_mcp_request_duration_seconds{server,tool}`, budget ratios. All labels come from fixed sets.
- **Tracing:** OTel spans `flow.<flow>.<step>` and `crew.<name>` to the existing collector → Jaeger. CrewAI's own
  telemetry and tracing are off (`CREWAI_DISABLE_TELEMETRY`, `CREWAI_DISABLE_TRACKING`, `CREWAI_TRACING_ENABLED=false`,
  `suppress_flow_events`, `tracing=False`).

### Resources

| | |
|---|---|
| Production virtualenv | 161 locked packages (v3: 177): LangGraph/LangChain removed; anthropic 2.3.0, mcp 1.30.0, reportlab 5.1.0 added |
| Model | 127 MB (bge-small-en-v1.5 ONNX, 384 dimensions) |
| Image | v3 estimate ~0.7 GB; v4 drops the LangChain family and adds ReportLab (pure Python, ~4 MB). CI reports the real size; no container runtime here |
| Idle RSS / reindex peak | ~310 MiB / ~700 MiB (v3 measurements; the flows add no resident model) |
| Requests / limits | 250m / 768Mi and 1 CPU / 1280Mi; trigger pods 10m / 48Mi |
