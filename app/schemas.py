"""Pydantic models shared by the flows, the crews and the API.

`ModelChangeSet` mirrors MODEL_OUTPUT_JSON_SCHEMA in services/www/src/lib/seo-intel/changeset.ts exactly: Claude's
structured output is converted into v2 `Change` objects and validated by the web app's own validators
(callback /validate), so there is one definition of what a valid change is.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

ModelChangeType = Literal["title", "meta_description", "heading", "paragraph_edit", "paragraph_add", "code_block", "alt_text"]


class ModelChange(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: ModelChangeType
    block_id: str = Field(description='Block id from the article data ("b12"); "" for title and meta_description.')
    before: str
    after: str
    rationale: str
    evidence_ref: list[str] = Field(default_factory=list)
    source_urls: list[str] = Field(default_factory=list)


class ModelChangeSet(BaseModel):
    """What draft_changes asks Claude for (with_structured_output)."""

    model_config = ConfigDict(extra="forbid")
    summary: str
    changes: list[ModelChange]


class InternalLinkSuggestion(BaseModel):
    model_config = ConfigDict(extra="forbid")
    target_path: str
    anchor: str
    reason: str


class Source(BaseModel):
    model_config = ConfigDict(extra="forbid")
    url: str
    title: str = ""
    used_for: str = ""


class FactCheckFlag(BaseModel):
    model_config = ConfigDict(extra="forbid")
    claim: str
    reason: str
    severity: Literal["error", "warning"] = "warning"


class CodeBlock(BaseModel):
    model_config = ConfigDict(extra="forbid")
    lang: str
    code: str
    purpose: str = ""


class NewArticleDraft(BaseModel):
    """Output of the editorial crew. Goes through the same validate + human_review as every other draft."""

    model_config = ConfigDict(extra="forbid")
    title: str
    slug_suggestion: str
    meta_description: str
    outline: list[str]
    body_mdx: str
    code_blocks: list[CodeBlock] = Field(default_factory=list)
    sources: list[Source] = Field(default_factory=list)
    fact_check_flags: list[FactCheckFlag] = Field(default_factory=list)
    internal_links: list[InternalLinkSuggestion] = Field(default_factory=list)
    incomplete: bool = False
    incomplete_reason: str | None = None


class Relevance(BaseModel):
    model_config = ConfigDict(extra="forbid")
    relevant: bool
    reason: str
    # v5 (ask-blog-v3): which excerpt numbers address the question. Optional for backward compatibility: an answer
    # without it (older prompt, cached result, fake models in tests) means "all excerpts", as in v4.
    relevant_excerpts: list[int] = Field(default_factory=list, max_length=12, description="Numbers of the excerpts that directly help answer the question; [] when relevant=false.")


class Citation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str
    url: str


class AskAnswer(BaseModel):
    model_config = ConfigDict(extra="forbid")
    answer: str
    citations: list[Citation]
    known: bool = Field(description="False when the retrieved articles do not answer the question.")


# --- API ----------------------------------------------------------------------------------------------------------




class AskTurn(BaseModel):
    """One earlier turn of a site conversation, sent by the widget so a follow-up can be understood. Untrusted: it
    comes from the reader's browser, is checked like a question and only ever reaches the condense prompt as data."""

    model_config = ConfigDict(extra="forbid")
    q: str = Field(min_length=1, max_length=500)
    a: str = Field(default="", max_length=600)


class AskRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    question: str = Field(min_length=1, max_length=2000)
    ip_hash: str | None = Field(default=None, max_length=128)
    stream: bool = False
    # Earlier turns, oldest first (Admin → Ask the Blog → follow-up questions). Ignored when follow-ups are off.
    history: list[AskTurn] = Field(default_factory=list, max_length=5)
    # The article the reader has open, so retrieval can rank its sections a little higher. Ignored when page context is off.
    context_slug: str | None = Field(default=None, max_length=160, pattern=r"^[a-z0-9][a-z0-9-]*$")


class Standalone(BaseModel):
    """condense_question output: the follow-up rewritten so it can be understood without the conversation."""

    model_config = ConfigDict(extra="forbid")
    question: str = Field(description="The reader's latest question rewritten as one standalone question, in the reader's words where possible. Unchanged if it already stands alone.")

