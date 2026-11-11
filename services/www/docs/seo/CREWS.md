# SEO v4: Crews

Crews are used only where reasoning or writing adds value. Data steps (sync, scoring, crawling, link limits) are plain
Python in the flows ([FLOWS.md](FLOWS.md)). All three crews share `app/crews/common.py`: the Claude adapter, the
allowlisted tools, the limits and the runner.

## Common rules

- **Process:** sequential. `allow_delegation=False`, `allow_code_execution=False`, `memory=False`, `planning=False`, no
  knowledge sources, `share_crew=False`, `tracing=False`.
- **Limits:** per agent `max_iter` (`CREW_MAX_ITER`, 4), `max_rpm` (`CREW_MAX_RPM`, 20, also on the crew),
  `max_execution_time` (half of the crew timeout), `max_retry_limit` 1. Per run `CREW_MAX_TOKENS_PER_RUN` (150k, checked
  before every call) and `CREW_TIMEOUT_SECONDS` (600, wall clock). Hitting a limit returns a **partial result marked
  `incomplete`** with the reason; nothing loops silently. A budget refusal is re-raised and the flow ends `paused_budget`;
  the tokens and cost the crew spent before it are added to the run (`CrewBudgetExceeded`).
- **Cancellation:** a crew runs in a worker thread. When its flow run is cancelled (reject/regenerate cancel the drafting
  run, the run's `SEO_FLOW_TIMEOUT_SECONDS`, `POST /flows/runs/{id}/cancel`) or the crew's wall clock fires, the crew run
  is marked cancelled and its in-flight model call is cancelled; the LLM adapter (and the tool adapter) refuse every
  later call, so the thread stops calling Claude at its next step.
- **Output caps:** agents that re-emit a whole article body or change set (`writer`, `reviewer`, `editor`) get
  `CREW_LONG_OUTPUT_MAX_TOKENS` (default 16,000); all others 4,096. An answer cut off at `max_tokens` (the LLM layer's
  `InvalidOutput`/`Truncated`) is an error: the crew stops and the result is `incomplete` ("model answer rejected"),
  never a silently shortened article.
- **Attribution:** every crew call carries `CallSpec.run_id` (the flow run) and `CallSpec.agent` (the agent key), and
  gets an OTel span `crew.<crew>.<agent>` under `crew.<crew>`. CrewAI's own tracing stays off: it exports to CrewAI's
  platform (`CREWAI_TRACING_ENABLED=false`, `tracing=False`). The usage `purpose` stays per crew (`crew`, `draft`,
  `regenerate`, `report`): budget scopes and metrics are keyed on it.
- **LLM:** `ClaudeCrewLLM`, a CrewAI `BaseLLM` that calls this service's `AnthropicLlm` (official SDK, anthropic 2.3.0).
  Every call goes through the budget guard and writes a `seo_llm_usage` row. `SEO_DRAFT_MODEL` (default
  `claude-sonnet-5-5`) for writing, `SEO_CLASSIFY_MODEL` (default `claude-haiku-5-5`) for cheap work.
  **Per-agent override:** `SEO_CREW_MODELS`, a JSON object `"<crew>.<agent>" → model` (default in the ConfigMap:
  `{"optimization.analyst":"claude-haiku-5-5"}`).
- **Prompt caching:** the stable prefix (the untrusted-data rule + CrewAI's per-agent system prompt with role, goal,
  backstory and tool descriptions) is sent as cached system blocks (`cache_control: ephemeral`), so repeated ReAct calls
  of one agent read it from the cache. CrewAI's own Anthropic provider also stamps `cache_control`, but needs
  `anthropic~=0.73` (the `crewai[anthropic]` extra), which conflicts with the anthropic 2.3.0 pin (D-55).
- **Refusals:** Sonnet/Opus calls use the server-side refusal fallback (`fallbacks: "default"`); a final refusal raises
  and the step records it.
- **Untrusted input:** tool results, article text, queries and metrics arrive as `<data name="…">` blocks with closing
  tags neutralised (and wrapped again on the Python side as defence in depth); every backstory says it is reference
  material, never instructions, and that the agent cannot publish, approve or change anything.
- **Structured output:** the final task of each crew has `output_pydantic`; the result is validated again in Python and
  then by the web app's own validators.

## Tools (read-only allowlist)

`ALLOWED_TOOLS = {read_article, vector_search, gsc_queries_for_topic, gsc_queries_for_page, style_guide, fetch_allowlisted_docs}`.
`build_tools` refuses anything else; a test asserts the exact sets per agent. No shell, arbitrary HTTP, code execution or
database write. The one write in the system (create/update a draft) is a flow step, never an agent.

| Tool | Does | Through |
|---|---|---|
| `read_article` | one published article by path or id | web callback `/articles/read` (published only) |
| `vector_search` | semantic search over published chunks | `app/services/content.search` (the same function the public MCP uses) |
| `gsc_queries_for_topic` | 28-day aggregated queries containing the topic words | web callback `/gsc/queries`, personal-data-looking queries removed |
| `gsc_queries_for_page` | the same for the article being optimised (bound per run; an agent cannot ask about another page) | web callback |
| `style_guide` | the site's style guide | sent with the article context or brief |
| `fetch_allowlisted_docs` | official documentation | checked in Python (https, default port, no credentials, no IP literal, allowlisted host), then fetched by the web app's SSRF-safe fetcher (DNS resolved inside the socket, private ranges refused, redirects re-checked) |

Docs allowlist (`SEO_AGENT_DOCS_ALLOWLIST`): kubernetes.io, docs.aws.amazon.com, developer.hashicorp.com,
docs.python.org, docs.crewai.com, modelcontextprotocol.io.

## Optimization Crew (existing articles)

| Agent | Job | Tools |
|---|---|---|
| SEO analyst | Turn the evidence (GSC queries, CTR gap against the site's curve, decay) into a short problem statement | gsc_queries_for_page, read_article |
| Editor | A **minimal** change set (title, meta, headings, paragraph edits, alt text, FAQ paragraphs) in the site's style; never links | read_article, style_guide |
| Technical reviewer | Check every changed command, version and claim against official docs; unsourced → `needs_fact_check` | fetch_allowlisted_docs |

Output: `OptimizationResult` = `problem_statement` + `change_set` (the v2 `ModelChangeSet`: type, block_id, before, after,
rationale, evidence_ref, source_urls) + `needs_fact_check[]`. The change set goes through v2's `toChanges` and
`validateChangeSet`, so the existing diff view works unchanged; the fact-check items become flags. If the reviewer
doesn't finish, the editor's change set is used with an "unreviewed" flag on every change (and approval needs a human
look anyway).

## Editorial Crew (new articles)

| Agent | Job | Tools |
|---|---|---|
| Researcher | Related site articles and official docs; list every source URL | vector_search, read_article, fetch_allowlisted_docs |
| Technical writer | Full MDX draft per STYLE_GUIDE.md, minimal working code | read_article |
| Technical reviewer | Commands, flags, versions against the sources; unsourced → `needs_fact_check` | fetch_allowlisted_docs |
| SEO editor | Title ≤ 60, meta 120–155, heading plan for the target queries, ≤ 3 internal links to existing paths, **metadata JSON only** (`SeoMetadata`, no body) | gsc_queries_for_topic, vector_search |

Output: `NewArticleDraft` (title, slug_suggestion, meta_description, outline, body_mdx, code_blocks, sources[],
fact_check_flags[], internal_links[], incomplete, incomplete_reason), **assembled in code** (prompt `seo-crew-v3`):
`body_mdx` is the technical reviewer's corrected body (everything before its `NEEDS_FACT_CHECK:` line), `code_blocks`
are extracted from it, the reviewer's `NEEDS_FACT_CHECK` items join the editor's `fact_check_flags`, and the rest is the
SEO editor's metadata. The editor never re-emits the body, so a long article cannot be truncated inside its JSON and no
rewrite can slip in after the technical review (a body it emits anyway is ignored). Without a reviewed body the writer's
body is kept, flagged "technical review did not finish", and the draft is incomplete. A cited source the crew never
retrieved during the run is flagged automatically.

**Feedback (both crews):** a regenerate's reviewer feedback and the validator's errors from the automatic retry are kept
apart (`feedback`, `validator_feedback` in the flow state) and both reach the prompt, so a validator retry never drops
what the reviewer asked for. Feedback from a run started through the admin MCP (`triggered_by="mcp"`) is untrusted: it
goes in a `<data name="api_feedback">` block framed as suggestions, never as instructions.

## Report Crew

One agent (`SEO report writer`, `SEO_CLASSIFY_MODEL`) writes a 120–250-word weekly/monthly briefing from **pre-computed**
numbers. It cannot compute or change metrics. `facts()` turns the report payload (v1 `buildReport`) into labelled,
pre-formatted figures; the agent may only copy them. `check_numbers()` then extracts every number in the text and
requires each to equal a fact at the precision written ("14%" matches 14.1 %, "18%" doesn't; ISO dates must be period
dates). **Any mismatch fails the report**: the narrative isn't stored or sent, the run is `failed`
(`report_mismatch`), and the numbers-only PDF is still saved.

## Internal linking (no crew)

Enforced in code by v2's deterministic planner, fed with pgvector + shared-query relevance (INTERNAL_LINKING.md): ≤ 3
new links per article per draft, ≤ 1 internal link per 250 words, one link per target, nothing in headings, code,
captions or the first sentence, ≥ 100 words between new links, ≤ 5 new inbound links per target per weekly run,
anchors from existing text and varied, never a redirect, `noindex` or 404 target.

## Tests (no API calls)

`tests/test_crews.py` runs the real CrewAI crews with a deterministic model (scripted ReAct turns, real tool calls through
the fake web app): schema validation, cited-but-unretrieved sources, token cap → incomplete, wall-clock timeout →
incomplete, budget → re-raised, agents' tools and guardrails as built, per-agent models, the Optimization Crew end to end
in its flow, injected instructions in article text changing nothing, the number check, and the Report Crew on the cheap
model.
