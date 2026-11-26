"""Settings group "Shared knowledge base": the moks-rag service (app/moks_rag.py, app/site_context.py).

- RAG_CANNIBALIZATION_MIN_SIMILARITY is read on every check (new_article_flow's ground step, POST
  /site-context/cannibalization): live. Empty by default, so only the keyword checks flag until the owner sets it.
- The two timeouts are copied into the client when it is built at start-up: restart.

Not here, on purpose: RAG_API_URL and RAG_BEARER_TOKEN (a saved URL would send the shared token wherever it points;
both come from the deployment, the token from a Kubernetes Secret) and the two collection names (moks-rag fixes them).
"""

from __future__ import annotations

from ..registry import Field, Group

GROUP = Group(
    id="knowledge-base",
    title="Shared knowledge base",
    description="The shared moks-rag service: how close an existing article must be to be flagged as cannibalization, and how long the agent waits for it.",
    fields=(
        Field(
            "RAG_CANNIBALIZATION_MIN_SIMILARITY",
            "rag_cannibalization_min_similarity",
            "Cannibalization: lowest similarity",
            "A published article at least this similar to a new article's target keyword is flagged on the draft (cosine similarity in the agent's embeddings model). Empty: only the keyword checks flag (the article's title has every word of the keyword, or it targets the same keyword).",
            "number",
            min=0.05,
            max=1,
        ),
        Field("RAG_QUERY_TIMEOUT_SECONDS", "rag_query_timeout_s", "Search time limit", "How long one search of the knowledge base may take before it is retried.", "number", apply="restart", unit="s", min=2, max=120),
        Field("RAG_TIMEOUT_SECONDS", "rag_timeout_s", "Upload time limit", "How long sending one document may take before it is retried. The service embeds every chunk before it answers.", "number", apply="restart", unit="s", min=5, max=600),
    ),
)
