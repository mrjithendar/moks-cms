"""Settings group "Retrieval": how Ask the Blog and the agents' search pick passages.

Ask the Blog's switch, audience, daily limit and cache time are not here: they are set in Ask the Blog (the web
app's runtime options, app/ask_runtime.py) and a knob has one place.

- ASK_BLOG_TOP_K and ASK_BLOG_MIN_SCORE are read on every question (app/services/ask_pipeline.py): live.
- ASK_BLOG_RETENTION_DAYS is read by the hourly prune (app/main.py): live.
- The reranker's switch and its three limits are read on every search (app/reranker.py RerankGate): live. Its thread
  count is copied into the model's ONNX Runtime session when the model loads: restart. RAG_RERANKER_DIR (the model's
  folder) is not here: the image sets it, and an admin should not point the service at another path.

The default score floor is calibrated per embeddings model (app/calibration.py). A value saved here replaces it.
"""

from __future__ import annotations

from ..registry import Field, Group

GROUP = Group(
    id="retrieval",
    title="Retrieval",
    description="How many passages an answer is built from, how similar a passage must be, whether a second model reorders them, and how long questions are kept.",
    fields=(
        Field("ASK_BLOG_TOP_K", "ask_top_k", "Passages per answer", "The most passages retrieved for one question.", "integer", unit="passages", min=1, max=12),
        Field(
            "ASK_BLOG_MIN_SCORE",
            "ask_min_score",
            "Lowest similarity",
            "A passage less similar than this is not used. Empty uses the value calibrated for the embeddings model. Too high and questions go unanswered; too low and answers cite unrelated passages.",
            "number",
            min=0,
            max=0.95,
        ),
        Field("ASK_BLOG_RETENTION_DAYS", "ask_retention_days", "Keep questions for", "Logged questions older than this are deleted.", "integer", unit="days", min=1, max=3650),
        Field(
            "RAG_RERANKER_ENABLED",
            "rag_reranker_enabled",
            "Rerank passages",
            "A second model reads the question with each passage that passed the lowest similarity and puts the best answers first. Better order, slower searches. If it fails or is too slow, search keeps the order it has without it.",
            "boolean",
        ),
        Field(
            "RAG_RERANKER_CANDIDATES",
            "rag_reranker_candidates",
            "Passages the reranker reads",
            "How many of the retrieved passages it reorders, best first. Fewer is faster; the rest keep their order after them. 0 or empty: all of them.",
            "integer",
            unit="passages",
            min=0,
            max=100,
        ),
        Field(
            "RAG_RERANKER_TIMEOUT_MS",
            "rag_reranker_timeout_ms",
            "Reranker time limit",
            "A search waits this long for the reranker, then uses the order it has without it. 0 or empty: no time limit.",
            "integer",
            unit="ms",
            min=0,
            max=30000,
        ),
        Field(
            "RAG_RERANKER_MAX_CONCURRENT",
            "rag_reranker_max_concurrent",
            "Reranks at once",
            "The most searches the reranker works on at the same time; a search beyond that skips it. 0 or empty: no limit.",
            "integer",
            unit="searches",
            min=0,
            max=64,
        ),
        Field("RAG_RERANKER_THREADS", "rag_reranker_threads", "Reranker CPU threads", "CPU threads the reranker uses for one search. More is faster while the pod has free CPU.", "integer", apply="restart", unit="threads", min=1, max=16),
    ),
)
