# SEO intelligence platform docs

| Doc | Contents |
|---|---|
| [MANUAL_SETUP.md](MANUAL_SETUP.md) | Steps only a person can do (GCP, service account, GSC/GA4 access, cluster secrets, first backfill) |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Architecture and data-flow diagrams, modules, schema, API, environment variables, local development |
| [OPERATIONS.md](OPERATIONS.md) | Deployment, daily sync, backfill, recommendation workflow, admin guide, troubleshooting, alerts, backup/rollback |
| [SCORING.md](SCORING.md) | Recommendation scoring, normalisation, recalibration from outcomes |
| [SECURITY.md](SECURITY.md) | Access control, secrets, SSRF, LLM safeguards, content integrity, review findings |
| [DECISIONS.md](DECISIONS.md) | Where the implementation deviates from the brief, and why |
| [DISCOVERY.md](DISCOVERY.md) · [PLAN.md](PLAN.md) · [PROGRESS.md](PROGRESS.md) | Phase 1 findings, plan, progress log |
| [prometheus-alerts.yml](prometheus-alerts.yml) | Alert rules for the miniKube repo |
| [REVIEW_WORKFLOW.md](REVIEW_WORKFLOW.md) · [SUBMISSION.md](SUBMISSION.md) · [INTERNAL_LINKING.md](INTERNAL_LINKING.md) · [STYLE_GUIDE.md](STYLE_GUIDE.md) | v2: review and approval, search-engine submission, internal links, the drafting style guide |
| [FLOWS.md](FLOWS.md) | v4: every CrewAI Flow (diagrams, triggers, state), the split-flow approval gate, persistence and locks, scheduling, internal API, operations, resources |
| [CREWS.md](CREWS.md) | v4: the Optimization, Editorial and Report crews: agents, tasks, tools, limits, output schemas |
| [MCP.md](MCP.md) | v4: public and admin MCP servers, every tool/resource/prompt with scopes, OAuth flow, connecting from Claude and MCP Inspector, kill switches, revocation |
| [RAG.md](RAG.md) | Ask the Blog (guards, abuse/cost controls, privacy), chunking, embeddings options, pgvector index and reindexing |
| [COSTS.md](COSTS.md) | v4: tokens and cost per flow, monthly estimate for the current site, budget controls |
| [PROMOTION.md](PROMOTION.md) | Promotion: channel opportunities and drafted posts for published articles, content ideas from Search Console and Reddit, the read-only Reddit client, flows, data, API, settings |
| [AGENTS.md](AGENTS.md) | v3 (superseded): pointer to the v4 docs |
