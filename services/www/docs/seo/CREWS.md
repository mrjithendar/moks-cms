# SEO v4: Crews

Crews are used only where reasoning or writing adds value. Data steps (sync, scoring, crawling, link limits) are plain
Python in the flows ([FLOWS.md](FLOWS.md)). All three crews share `app/crews/common.py`: the Claude adapter, the
allowlisted tools, the limits and the runner.

## Common rules

- **Process:** sequential. `allow_delegation=False`, `allow_code_execution=False`, `memory=False`, `planning=False`, no
  knowledge sources, `share_crew=False`, `tracing=False`.
- **Limits:** per agent `max_iter` (`CREW_MAX_ITER`, 4; overridden per agent by `SEO_CREW_MAX_ITERS`, a JSON object of
  `"<crew>.<agent>"` → 1–20, in production researcher 10, writer 6, technical reviewer 8 of the Editorial Crew), `max_rpm` (`CREW_MAX_RPM`, 20, also on the crew),
  `max_execution_time` (half of the crew timeout), `max_retry_limit` 1. Per run `CREW_MAX_TOKENS_PER_RUN` (300k, checked
  before every call) and `CREW_TIMEOUT_SECONDS` (1200, wall clock). The Anthropic client waits `SEO_LLM_TIMEOUT_SECONDS`
  (240 in production, default 120) per request. Hitting a limit returns a **partial result marked
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

## Skills (D-96)

Every crew agent can be given **skills**: short instructions for a kind of work (how to structure a troubleshooting
article, how to cover a security advisory, channel norms for promotion posts), managed on **AI room → Skills**
(`/admin/automation/skills`).

- **Where they live:** the web app's `seo_agent_skills` table (migration 0035). The 22 default skills are defined in
  `src/lib/seo-agent/skills.ts` (`DEFAULT_SKILLS`) and inserted when missing (`ensureDefaultSkills`), so a new default
  arrives with a deploy. Admins edit, disable and reset defaults (not delete: they would come back), and add, edit and
  delete their own. Every change is audited (`seo.skill.*`) and bumps the skill's version when its content changes.
- **How the agent gets them:** `run_crew` calls `GET /internal/seo-agent/skills` (the enabled skills) before building
  the crew. Unreachable or slower than 10 s → the run goes on without skills (`crew_skills_unavailable`). No database
  grant: the agent reads them through the callback API like the style guide.
- **Which agent gets which:** decided in code (`app/crews/skills.py`), never by the model. A skill names its agents
  (`editorial.writer`, or `news.*` for a crew) and optionally tags. Untagged: every run of those agents. Tagged: a run
  with any one of the tags. Each crew computes its run's tags from signals it already has:

  | Crew | Tags | From |
  |---|---|---|
  | Editorial | `intent:<…>` | the brief's intent: the editorial idea's, or (items without one, e.g. ML query clusters) the ML intent model's prediction for the item's queries when the model is in use and confident (`calendarBrief` → `mlIntentFor`). The model's `informational` also adds `intent:explainer` (main query starts with what/why) or `intent:how-to` |
  | Editorial | `source:<ml\|analytics\|ask\|promotion\|manual>`, `queries:many`, `revise` | the calendar idea's source (calendar-auto, D-95), ≥ 3 supporting queries, Improve (a current draft) |
  | Optimization | `category:<…>` | the recommendations being implemented |
  | News | `topic:<slug>`, `mode:<single\|digest>`, `cve`, `release` | the news classifier's topics for the cluster, the job mode, a CVE id in the story, a version or release word in a story title |
  | Report | `report:<weekly\|monthly>` | the report period |
  | Promotion | none | the copywriter and strategist are separate agents |

- **How they reach the model:** as CrewAI Agent Skills already activated (INSTRUCTIONS level), so CrewAI renders their
  full text into the agent's system prompt (`<skills><skill name="…">…</skill></skills>`), which `ClaudeCrewLLM` sends
  as the cached system block. No `load_skill` tool is added: it would bypass the tool allowlist and the model could
  skip a skill. Registry refs (`@org/name`) are never used: they download from CrewAI's platform. An agent with skills
  gets one more backstory line: where a skill differs from the task's rules or output format, the task wins.
- **Limits:** at most 6 skills and 20,000 characters of skill text per agent (`crew_skill_skipped` beyond), 8,000
  characters per skill, and no `<skill>` tags inside a skill (refused on save, skipped on read).
- **Observability:** `CrewOutcome.skills` (agent → `name@vN`), the crew span attribute `crew.skills`, and `skills` and
  `skill_tags` on the `crew_finished` log line.
- **Tests:** `tests/test_skills.py` (agent: matching per agent and tag, rendered in the cached system block only, no
  loader tool, failure → no skills, news tags from the story, the web app's agent list and default tags in step with
  the crews), `tests/agent-skills.test.ts` (web app: defaults, edit/disable/reset/delete rules, validation, routes, the
  callback, the ML intent in the calendar brief).

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

Docs allowlist (`SEO_AGENT_DOCS_ALLOWLIST`, read by both services; a host or its subdomains): the default is the list of
official documentation sites in `services/seo-agent/app/config.py` (`DEFAULT_DOCS_ALLOWLIST`), mirrored in
`services/www/src/lib/seo-agent/config.ts`; a test keeps the two equal. It covers the tools the site writes about
(Kubernetes, Helm, Docker, Istio, Kong, Argo CD, Karpenter, KEDA, Velero, Cilium, Linkerd, Prometheus, Grafana,
OpenTelemetry, AWS, Google Cloud, Azure, Terraform, Ansible, GitHub, GitLab, Cloudflare, PostgreSQL, Redis, Next.js,
React, Node.js, Go, Python, FastAPI, Pydantic, CrewAI, LangChain, Claude, MCP). Forums, blogs and code hosts are not on it.

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
| Researcher (Sonnet, ≤ 10 turns) | Related site articles and the specific official doc pages per outline section; exact commands, versions, limits; names the sections it found no source for; lists every source URL | vector_search, read_article, fetch_allowlisted_docs |
| Technical writer (Opus) | Full MDX draft per STYLE_GUIDE.md from the research and the author's first-hand notes, to the brief's reading time (or 1,500–2,500 words), minimal working code | read_article |
| Technical reviewer (Opus) | Commands, flags, versions against the sources; unsourced → `needs_fact_check`; corrects without shortening | fetch_allowlisted_docs |
| SEO editor | Title ≤ 60, meta 120–155, heading plan for the target queries, ≤ 3 internal links to existing paths, **metadata JSON only** (`SeoMetadata`, no body) | gsc_queries_for_topic, vector_search |

Output: `NewArticleDraft` (title, slug_suggestion, meta_description, outline, body_mdx, code_blocks, sources[],
fact_check_flags[], internal_links[], incomplete, incomplete_reason), **assembled in code** (prompt `seo-crew-v4`):
`body_mdx` is the technical reviewer's corrected body (everything before its `NEEDS_FACT_CHECK:` line), `code_blocks`
are extracted from it, the reviewer's `NEEDS_FACT_CHECK` items join the editor's `fact_check_flags`, and the rest is the
SEO editor's metadata. The editor never re-emits the body, so a long article cannot be truncated inside its JSON and no
rewrite can slip in after the technical review (a body it emits anyway is ignored). Without a reviewed body the writer's
body is kept, flagged "technical review did not finish", and the draft is incomplete. A cited source the crew never
retrieved during the run is flagged automatically.

**Brief inputs (v4 prompt).** Besides title, gap, audience, intent, outline, queries, code examples and internal links,
the crew now reads the item's diagrams, reading time and notes, plus two server-side additions:

- `authorNotes` ("First-hand notes" on the calendar item, ≤ 6,000 characters): what the author built, ran, measured or
  decided. The researcher, writer and reviewer get it as the data block `author_first_hand_notes`. It is the only
  material the writer may use without a research source, written in the first person; the reviewer keeps it unless a
  source contradicts it.
- `examples`: up to two published blog articles (newest in the item's category first; members-only and noindex
  excluded; 12,000 characters each), added by the web app's `/calendar/{id}/brief`. Only the writer gets them, as
  examples of voice, depth and structure; it is told to take no facts or sentences from them.

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

## Promotion Crew

Two single-agent crews in `app/crews/promotion.py`, both **without tools** (nothing to fetch, post or write with) and
with a 6,000-token output cap. Usage purpose `crew` (the monthly budget applies). See [PROMOTION.md](PROMOTION.md).

| Agent | Job | Input | Output |
|---|---|---|---|
| Promotion copywriter | One post per requested channel for a published article, first person, only what the article says, the tagged link exactly as given | the article (title, description, opening text, top queries) and the channels to draft (guidance, length limit, link, thread titles) from the web app | `PromoPosts` (channel, title, body, notes) |
| Content strategist | Article ideas that have an audience, each citing evidence copied from the signals | Search Console topics and queries, fetched Reddit threads, covered and planned titles | `ContentIdeas` (title, angle, outline, target_query, channels, evidence) |

Which channels to draft, their scores and links are decided by the web app's deterministic code before the crew runs.
After it, `clean_posts` keeps one post per requested channel and `clean_ideas` drops ideas without evidence (both clamp
sizes to what the web app accepts); the web app then checks each draft and verifies each idea's evidence against its
own data. Output that does not match the schema is `incomplete`, with nothing saved for that article.

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
model. `tests/test_promotion.py`: the two promotion flows with a fake crew (drafts saved for review, nothing
published, switched off, budget pause, ideas kept only with verified evidence), the crew's output handling, and the
Promotion Crew with the deterministic model.
