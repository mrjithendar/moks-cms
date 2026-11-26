# SEO v3 agents (superseded)

v3's LangGraph orchestration was replaced in v4 by CrewAI Flows; LangGraph and LangChain are no longer installed. See:

- [FLOWS.md](FLOWS.md): every flow (diagrams, triggers, state, the split-flow approval gate, scheduling, operations)
- [CREWS.md](CREWS.md): the Optimization, Editorial and Report crews, tools and limits
- [MCP.md](MCP.md): the public and admin MCP servers and their authorization
- [RAG.md](RAG.md) · [COSTS.md](COSTS.md) · [DECISIONS.md](DECISIONS.md) D-41–D-53 (v3) and D-54 onward (v4)

The v3 text is in git history (`git show 7ac533f:services/www/docs/seo/AGENTS.md`). What carried over unchanged: the
approval gate in the web app (D-43, `publishWithApproval`), the callback API pattern (D-44), the pgvector index and
chunker (D-45), CrewAI's unused stores (D-47; LanceDB is not installed, D-103), Ask-the-Blog budget separation (D-48).
