"""Data access for seo_ml_flow: reads the web app's synced tables (read-only) and writes the v5 ML tables
(migration 0019). Postgres in production, memory in tests. The web app reads the outputs; this service never writes
the web app's own tables except `seo_ml_*`, `seo_rag_eval_runs` and the label tasks it creates."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import Any, Protocol

DEFAULT_WEIGHTS = {"searchOpportunity": 30, "rankingOpportunity": 20, "relevance": 20, "qualityGap": 15, "trend": 10, "effort": 5}


class MlStore(Protocol):
    async def latest_gsc_date(self) -> date | None: ...
    async def page_daily(self, since: date) -> list[dict[str, Any]]: ...
    async def top_queries(self, days: int, limit: int) -> list[dict[str, Any]]: ...
    async def query_performance(self, days: int, limit: int) -> list[dict[str, Any]]: ...
    async def query_clusters(self) -> list[dict[str, Any]]: ...
    async def cached_embeddings(self, queries: list[str], model: str) -> dict[str, list[float]]: ...
    async def save_embeddings(self, rows: dict[str, list[float]], model: str) -> None: ...
    async def labels(self, task: str) -> list[dict[str, Any]]: ...
    async def ask_gaps(self) -> list[dict[str, Any]]: ...
    async def add_label_tasks(self, task: str, items: list[tuple[str, dict[str, Any]]]) -> int: ...
    async def intent_training(self, prompt_version: str) -> list[tuple[str, str]]: ...
    async def outcomes(self) -> list[dict[str, Any]]: ...
    async def current_weights(self) -> dict[str, float]: ...
    async def articles(self) -> list[dict[str, Any]]: ...
    async def article_queries(self, days: int) -> dict[str, set[str]]: ...
    async def ga4_pairs(self) -> list[dict[str, Any]]: ...
    async def active_model(self, kind: str) -> dict[str, Any] | None: ...
    async def latest_model(self, kind: str) -> dict[str, Any] | None: ...
    async def save_model(self, row: dict[str, Any], *, activate: bool) -> None: ...
    async def deactivate(self, kind: str) -> None: ...
    async def replace_outputs(self, table: str, rows: list[dict[str, Any]]) -> None: ...
    async def add_proposal(self, row: dict[str, Any]) -> None: ...
    async def record_rag_eval(self, config: str, metrics: dict[str, Any]) -> None: ...
    async def related_scores(self, article_id: str) -> dict[str, float]: ...


OUTPUT_TABLES = {
    "seo_ml_decay_signals": ("page", "window_start", "window_end", "decaying", "trend_slope", "drop_pct", "confidence", "method_version", "evidence"),
    "seo_ml_query_clusters": ("query", "cluster_id", "cluster_label", "model_version"),
    "seo_ml_intent_predictions": ("query", "intent", "confidence", "model_version"),
    "seo_ml_related_articles": ("article_id", "related_id", "rank", "score", "components", "model_version"),
}
JSON_COLS = {"evidence", "components"}


class PgMlStore:
    def __init__(self, pool: Any):
        self.pool = pool

    async def _all(self, q: str, args: Any = None) -> list[dict[str, Any]]:
        async with self.pool.connection() as c:
            return list(await (await c.execute(q, args)).fetchall())

    async def latest_gsc_date(self) -> date | None:
        rows = await self._all("select max(date) as d from seo_gsc_daily_totals where search_type = 'web'")
        return rows[0]["d"] if rows else None

    async def page_daily(self, since: date) -> list[dict[str, Any]]:
        return await self._all(
            "select page, date, sum(clicks)::float8 as clicks, sum(impressions)::float8 as impressions from seo_gsc_page_daily where search_type = 'web' and date >= %s group by page, date",
            (since,),
        )

    async def top_queries(self, days: int, limit: int) -> list[dict[str, Any]]:
        return await self._all(
            """select query, sum(impressions)::float8 as impressions, sum(clicks)::float8 as clicks from seo_gsc_query_daily
               where search_type = 'web' and date > (select max(date) from seo_gsc_daily_totals where search_type = 'web') - %s
               group by query order by sum(impressions) desc limit %s""",
            (days, limit),
        )

    async def query_performance(self, days: int, limit: int) -> list[dict[str, Any]]:
        """Page × query over the last `days` days of Search Console (web), most impressions first: clicks,
        impressions and the impression-weighted average position (seo_intel's documents, app/seo_intel.py)."""
        return await self._all(
            """select page, query, sum(clicks)::float8 as clicks, sum(impressions)::float8 as impressions,
                 (sum(position * impressions) filter (where position is not null) / nullif(sum(impressions) filter (where position is not null), 0))::float8 as position
               from seo_gsc_query_daily
               where search_type = 'web' and date > (select max(date) from seo_gsc_daily_totals where search_type = 'web') - %s
               group by page, query having sum(impressions) > 0 order by sum(impressions) desc limit %s""",
            (days, limit),
        )

    async def query_clusters(self) -> list[dict[str, Any]]:
        """The query clusters seo_ml_flow last wrote (seo_ml_query_clusters)."""
        return await self._all("select query, cluster_id, cluster_label from seo_ml_query_clusters order by cluster_id, query")

    async def cached_embeddings(self, queries: list[str], model: str) -> dict[str, list[float]]:
        rows = await self._all("select query, embedding from seo_ml_query_embeddings where model = %s and query = any(%s)", (model, queries))
        return {r["query"]: list(r["embedding"]) for r in rows}

    async def save_embeddings(self, rows: dict[str, list[float]], model: str) -> None:
        async with self.pool.connection() as c, c.cursor() as cur:
            await cur.executemany(
                "insert into seo_ml_query_embeddings (query, model, embedding) values (%s, %s, %s) on conflict (query, model) do nothing",
                [(q, model, v) for q, v in rows.items()],
            )

    async def labels(self, task: str) -> list[dict[str, Any]]:
        return await self._all("select item, suggestion, label, status from seo_ml_labels where task = %s", (task,))

    async def ask_gaps(self) -> list[dict[str, Any]]:
        try:
            return await self._all("select normalized, asked from seo_ask_gaps where status = 'open'")
        except Exception:
            return []

    async def add_label_tasks(self, task: str, items: list[tuple[str, dict[str, Any]]]) -> int:
        n = 0
        async with self.pool.connection() as c:
            for item, sug in items:
                cur = await c.execute("insert into seo_ml_labels (task, item, suggestion) values (%s, %s, %s::jsonb) on conflict (task, item) do nothing", (task, item, json.dumps(sug)))
                n += cur.rowcount or 0
        return n

    async def intent_training(self, prompt_version: str) -> list[tuple[str, str]]:
        rows = await self._all("select query, intent from seo_query_intents where source = 'llm' and prompt_version = %s", (prompt_version,))
        data = {r["query"]: r["intent"] for r in rows}
        for r in await self.labels("intent_check"):  # the owner's spot-check corrections win
            lab = r.get("label") or {}
            if r["status"] in ("confirmed", "changed") and lab.get("intent"):
                data[r["item"]] = lab["intent"]
        return sorted(data.items())

    async def outcomes(self) -> list[dict[str, Any]]:
        """Implemented recommendations with outcomes, oldest first, with pre-change snapshots only: score_inputs and the
        evidence are frozen when the recommendation leaves review, baseline_metrics is captured at "implemented", and
        pre_baseline_clicks is history before that. Nothing is read from today's post body, decay signals, intents or
        clusters: those describe the page after the change (priority.training_row maps the row to features)."""
        return await self._all(
            """select r.id::text as id, r.category, r.score_inputs, r.implemented_at, r.baseline_metrics, r.post_metrics_28d,
                 (select sum(clicks)::float8 from seo_gsc_page_daily g where g.page = r.url and g.search_type = 'web'
                    and g.date >= (r.implemented_at::date - 56) and g.date < (r.implemented_at::date - 28)) as pre_baseline_clicks,
                 (select value from seo_recommendation_evidence e where e.recommendation_id = r.id and e.metric = 'position' limit 1) as position,
                 (select value from seo_recommendation_evidence e where e.recommendation_id = r.id and e.metric = 'impressions' limit 1) as impressions
               from seo_recommendations r
               where r.implementation_status = 'implemented' and r.post_metrics_28d is not null and r.baseline_metrics is not null
               order by r.implemented_at, r.id"""
        )

    async def current_weights(self) -> dict[str, float]:
        rows = await self._all("select value -> 'weights' as w from setting where key = 'seo'")
        stored = rows[0]["w"] if rows and rows[0]["w"] else {}
        return {**DEFAULT_WEIGHTS, **{k: float(v) for k, v in stored.items() if k in DEFAULT_WEIGHTS}}

    async def articles(self) -> list[dict[str, Any]]:
        return await self._all(
            "select id::text as id, '/' || collection || '/' || slug as path, category from post where status = 'published' and deleted_at is null"
        )

    async def article_queries(self, days: int) -> dict[str, set[str]]:
        rows = await self._all(
            """select m.article_id::text as article_id, q.query from seo_gsc_query_daily q join seo_url_map m on m.url = q.page
               where q.search_type = 'web' and m.article_id is not null
                 and q.date > (select max(date) from seo_gsc_daily_totals where search_type = 'web') - %s
               group by 1, 2""",
            (days,),
        )
        out: dict[str, set[str]] = {}
        for r in rows:
            out.setdefault(r["article_id"], set()).add(r["query"])
        return out

    async def ga4_pairs(self) -> list[dict[str, Any]]:
        try:
            return await self._all("select landing_page, page_path, views from seo_ga4_page_pairs")
        except Exception:
            return []

    async def active_model(self, kind: str) -> dict[str, Any] | None:
        rows = await self._all("select kind, version, metrics, rule_metrics, beats_rule, active, status, reviewed_by, reviewed_at, artifact from seo_ml_models where kind = %s and active", (kind,))
        return rows[0] if rows else None

    async def latest_model(self, kind: str) -> dict[str, Any] | None:
        rows = await self._all(
            "select kind, version, metrics, rule_metrics, beats_rule, active, status, reviewed_by, reviewed_at, artifact from seo_ml_models where kind = %s order by trained_at desc, id desc limit 1",
            (kind,),
        )
        return rows[0] if rows else None

    async def save_model(self, row: dict[str, Any], *, activate: bool) -> None:
        async with self.pool.connection() as c, c.transaction():
            if activate:
                await c.execute("update seo_ml_models set active = false where kind = %s and active", (row["kind"],))
            await c.execute(
                """insert into seo_ml_models (kind, version, n_samples, metrics, rule_metrics, beats_rule, active, status, notes, reviewed_by, reviewed_at, artifact)
                   values (%s, %s, %s, %s::jsonb, %s::jsonb, %s, %s, %s, %s, %s, %s, %s)
                   on conflict (kind, version) do update set trained_at = now(), n_samples = excluded.n_samples, metrics = excluded.metrics,
                     rule_metrics = excluded.rule_metrics, beats_rule = excluded.beats_rule, active = excluded.active, status = excluded.status,
                     notes = excluded.notes, reviewed_by = coalesce(excluded.reviewed_by, seo_ml_models.reviewed_by),
                     reviewed_at = coalesce(excluded.reviewed_at, seo_ml_models.reviewed_at), artifact = excluded.artifact""",
                (
                    row["kind"], row["version"], int(row.get("n_samples") or 0), json.dumps(row.get("metrics") or {}, default=str), json.dumps(row.get("rule_metrics") or {}, default=str),
                    bool(row.get("beats_rule")), activate, row.get("status", "trained"), row.get("notes"), row.get("reviewed_by"), row.get("reviewed_at"), row.get("artifact"),
                ),
            )

    async def deactivate(self, kind: str) -> None:
        async with self.pool.connection() as c:
            await c.execute("update seo_ml_models set active = false where kind = %s and active", (kind,))

    async def replace_outputs(self, table: str, rows: list[dict[str, Any]]) -> None:
        cols = OUTPUT_TABLES[table]
        ph = ", ".join("%s::jsonb" if c in JSON_COLS else "%s" for c in cols)
        async with self.pool.connection() as c, c.transaction():
            await c.execute(f"delete from {table}")  # noqa: S608 - table and columns come from OUTPUT_TABLES
            async with c.cursor() as cur:
                await cur.executemany(
                    f"insert into {table} ({', '.join(cols)}) values ({ph})",  # noqa: S608
                    [tuple(json.dumps(r[k], default=str) if k in JSON_COLS else r[k] for k in cols) for r in rows],
                )

    async def add_proposal(self, row: dict[str, Any]) -> None:
        async with self.pool.connection() as c, c.transaction():
            await c.execute("update seo_ml_weight_proposals set status = 'superseded' where status = 'proposed'")
            await c.execute(
                "insert into seo_ml_weight_proposals (model_version, weights, current_weights, metrics, n_outcomes) values (%s, %s::jsonb, %s::jsonb, %s::jsonb, %s)",
                (row["model_version"], json.dumps(row["weights"]), json.dumps(row["current_weights"]), json.dumps(row["metrics"], default=str), row["n_outcomes"]),
            )

    async def record_rag_eval(self, config: str, metrics: dict[str, Any]) -> None:
        async with self.pool.connection() as c:
            await c.execute("insert into seo_rag_eval_runs (config, metrics) values (%s, %s::jsonb)", (config, json.dumps(metrics)))

    async def related_scores(self, article_id: str) -> dict[str, float]:
        """The related-articles model's scores for one article, only while the model is in use (active, or forced
        on the Models page) and its output is fresh; otherwise {} (the linking rule alone)."""
        try:
            rows = await self._all(
                """select r.related_id::text as id, r.score from seo_ml_related_articles r
                   where r.article_id::text = %s and r.computed_at > now() - interval '14 days'
                     and coalesce((select mode from seo_ml_overrides where kind = 'related'), 'auto') <> 'rule'
                     and (exists (select 1 from seo_ml_models where kind = 'related' and active)
                          or (select mode from seo_ml_overrides where kind = 'related') = 'model')""",
                (article_id,),
            )
        except Exception:
            return {}
        return {r["id"]: float(r["score"]) for r in rows}


@dataclass
class MemoryMlStore:
    """Fixture-backed store for tests."""

    gsc_end: date | None = None
    daily: list[dict[str, Any]] = field(default_factory=list)
    queries: list[dict[str, Any]] = field(default_factory=list)
    query_pages: list[dict[str, Any]] = field(default_factory=list)  # page × query rows (query_performance)
    embeddings: dict[tuple[str, str], list[float]] = field(default_factory=dict)
    label_rows: list[dict[str, Any]] = field(default_factory=list)
    gaps: list[dict[str, Any]] = field(default_factory=list)
    intents: list[tuple[str, str]] = field(default_factory=list)
    outcome_rows: list[dict[str, Any]] = field(default_factory=list)
    weights: dict[str, float] = field(default_factory=lambda: dict(DEFAULT_WEIGHTS))
    article_rows: list[dict[str, Any]] = field(default_factory=list)
    queries_by_article: dict[str, set[str]] = field(default_factory=dict)
    pairs: list[dict[str, Any]] = field(default_factory=list)
    models: list[dict[str, Any]] = field(default_factory=list)
    outputs: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    proposals: list[dict[str, Any]] = field(default_factory=list)
    rag_evals: list[dict[str, Any]] = field(default_factory=list)
    related_in_use: dict[str, dict[str, float]] = field(default_factory=dict)

    async def latest_gsc_date(self) -> date | None:
        return self.gsc_end

    async def page_daily(self, since: date) -> list[dict[str, Any]]:
        return [r for r in self.daily if (r["date"] if isinstance(r["date"], date) else date.fromisoformat(r["date"])) >= since]

    async def top_queries(self, days: int, limit: int) -> list[dict[str, Any]]:
        return sorted(self.queries, key=lambda r: -float(r["impressions"]))[:limit]

    async def query_performance(self, days: int, limit: int) -> list[dict[str, Any]]:
        return sorted(self.query_pages, key=lambda r: -float(r["impressions"]))[:limit]

    async def query_clusters(self) -> list[dict[str, Any]]:
        return [{k: r[k] for k in ("query", "cluster_id", "cluster_label")} for r in self.outputs.get("seo_ml_query_clusters", [])]

    async def cached_embeddings(self, queries: list[str], model: str) -> dict[str, list[float]]:
        return {q: self.embeddings[(q, model)] for q in queries if (q, model) in self.embeddings}

    async def save_embeddings(self, rows: dict[str, list[float]], model: str) -> None:
        for q, v in rows.items():
            self.embeddings.setdefault((q, model), v)

    async def labels(self, task: str) -> list[dict[str, Any]]:
        return [r for r in self.label_rows if r["task"] == task]

    async def ask_gaps(self) -> list[dict[str, Any]]:
        return list(self.gaps)

    async def add_label_tasks(self, task: str, items: list[tuple[str, dict[str, Any]]]) -> int:
        have = {(r["task"], r["item"]) for r in self.label_rows}
        new = [{"task": task, "item": i, "suggestion": s, "label": None, "status": "pending"} for i, s in items if (task, i) not in have]
        self.label_rows.extend(new)
        return len(new)

    async def intent_training(self, prompt_version: str) -> list[tuple[str, str]]:
        data = dict(self.intents)
        for r in await self.labels("intent_check"):
            if r["status"] in ("confirmed", "changed") and (r.get("label") or {}).get("intent"):
                data[r["item"]] = r["label"]["intent"]
        return sorted(data.items())

    async def outcomes(self) -> list[dict[str, Any]]:
        return list(self.outcome_rows)

    async def current_weights(self) -> dict[str, float]:
        return dict(self.weights)

    async def articles(self) -> list[dict[str, Any]]:
        return list(self.article_rows)

    async def article_queries(self, days: int) -> dict[str, set[str]]:
        return self.queries_by_article

    async def ga4_pairs(self) -> list[dict[str, Any]]:
        return list(self.pairs)

    async def active_model(self, kind: str) -> dict[str, Any] | None:
        return next((m for m in self.models if m["kind"] == kind and m.get("active")), None)

    async def latest_model(self, kind: str) -> dict[str, Any] | None:
        ms = [m for m in self.models if m["kind"] == kind]
        return ms[-1] if ms else None

    async def save_model(self, row: dict[str, Any], *, activate: bool) -> None:
        if activate:
            for m in self.models:
                if m["kind"] == row["kind"]:
                    m["active"] = False
        old = next((m for m in self.models if m["kind"] == row["kind"] and m["version"] == row["version"]), None)
        if old:
            self.models.remove(old)
        self.models.append({**row, "active": activate, "trained_at": datetime.now(UTC)})

    async def deactivate(self, kind: str) -> None:
        for m in self.models:
            if m["kind"] == kind:
                m["active"] = False

    async def replace_outputs(self, table: str, rows: list[dict[str, Any]]) -> None:
        self.outputs[table] = list(rows)

    async def add_proposal(self, row: dict[str, Any]) -> None:
        for p in self.proposals:
            if p["status"] == "proposed":
                p["status"] = "superseded"
        self.proposals.append({**row, "status": "proposed"})

    async def record_rag_eval(self, config: str, metrics: dict[str, Any]) -> None:
        self.rag_evals.append({"config": config, "metrics": metrics})

    async def related_scores(self, article_id: str) -> dict[str, float]:
        return dict(self.related_in_use.get(article_id, {}))
