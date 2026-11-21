"""Settings group "Retrieval": how Ask the Blog and the agents' search pick passages.

Ask the Blog's switch, audience, daily limit and cache time are not here: they are set in Ask the Blog (the web
app's runtime options, app/ask_runtime.py) and a knob has one place.

- ASK_BLOG_TOP_K and ASK_BLOG_MIN_SCORE are read on every question (app/services/ask_pipeline.py): live.
- ASK_BLOG_RETENTION_DAYS is read by the hourly prune (app/main.py): live.
- LANCEDB_ARTICLE_INDEX is read once, when the article mirror is built: restart.

The default score floor is calibrated per embeddings model (app/calibration.py). A value saved here replaces it.
"""

from __future__ import annotations

from ..registry import Field, Group

GROUP = Group(
    id="retrieval",
    title="Retrieval",
    description="How many passages an answer is built from, how similar a passage must be, how long questions are kept, and whether articles are also copied into LanceDB.",
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
        Field("LANCEDB_ARTICLE_INDEX", "lancedb_article_index", "Copy the article index into LanceDB", "Keeps a second copy of the article index in LanceDB for the hybrid search experiments.", "boolean", apply="restart"),
    ),
)
