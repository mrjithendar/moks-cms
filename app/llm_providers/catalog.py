"""The LLM providers this service knows how to reach, as data.

Each entry was checked against the provider's own documentation on the date in `checked`; the page is in `docs`.
Nothing here is from memory, and nothing here holds a model list or a price: models come from the provider's list
endpoint or are added by hand, and prices are entered by the admin (app/llm_providers/store.py).

A provider that is not listed is added through "custom" (any server that speaks the OpenAI Chat Completions API).
To add a provider: verify the four facts below in its current docs, append an entry, cite the page.

Adding an entry does not make anything call it. The adapters (one per `adapter`) arrive in a later change.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

Adapter = Literal["anthropic", "openai_compat", "gemini", "azure_openai", "bedrock"]
# How the key travels. "aws": no key here, the pod's AWS credentials sign the request. "none": no credentials.
Auth = Literal["x-api-key", "bearer", "api-key", "google_api_key", "aws", "none"]
# json_schema: the API takes a JSON Schema and holds the answer to it. per_model: only some of its models do.
# json_object: valid JSON, no schema. unknown: the server decides (custom); validated and repaired on this side.
Structured = Literal["json_schema", "per_model", "json_object", "unknown"]


@dataclass(frozen=True)
class Kind:
    id: str
    label: str
    adapter: Adapter
    auth: Auth
    base_url: str  # "" = the admin must enter it
    base_url_editable: bool
    list_models: str  # path under base_url, or "" = no list endpoint used here: models are added by hand
    structured: Structured
    needs: tuple[str, ...] = ()  # extra fields a provider of this kind must have: region, deployment, api_version
    env_key: str = ""  # an environment variable that is used when no key is saved
    many: bool = False  # more than one provider of this kind may exist
    docs: str = ""
    checked: str = ""
    note: str = ""


KINDS: tuple[Kind, ...] = (
    Kind(
        id="anthropic",
        label="Anthropic",
        adapter="anthropic",
        auth="x-api-key",  # plus the header anthropic-version: 2023-06-01
        base_url="https://api.anthropic.com",
        base_url_editable=False,
        list_models="/v1/models",
        structured="json_schema",
        env_key="ANTHROPIC_API_KEY",
        docs="https://platform.claude.com/docs/en/api/models-list",
        checked="2026-11-21",
        note="Prices for Claude models are built in (app/llm.py PRICES); an admin may override them per model.",
    ),
    Kind(
        id="openai",
        label="OpenAI",
        adapter="openai_compat",
        auth="bearer",
        base_url="https://api.openai.com/v1",
        base_url_editable=False,
        list_models="/models",
        structured="per_model",  # response_format json_schema from GPT-4o on; older models take JSON mode only
        env_key="OPENAI_API_KEY",
        docs="https://developers.openai.com/api/reference/resources/models/methods/list",
        checked="2026-11-21",
        note="Structured output: https://developers.openai.com/api/docs/guides/structured-outputs",
    ),
    Kind(
        id="gemini",
        label="Google Gemini (Gemini API)",
        adapter="gemini",
        auth="google_api_key",
        base_url="https://generativelanguage.googleapis.com/v1beta",
        base_url_editable=False,
        list_models="/models",  # paged: pageSize (up to 1000) and pageToken
        structured="json_schema",
        docs="https://ai.google.dev/api/models",
        checked="2026-11-21",
        note="Structured output: https://ai.google.dev/gemini-api/docs/structured-output",
    ),
    Kind(
        id="azure_openai",
        label="Azure OpenAI",
        adapter="azure_openai",
        auth="api-key",
        base_url="",  # https://<resource>.openai.azure.com
        base_url_editable=True,
        list_models="",  # a model is a deployment name the admin created in Azure
        structured="per_model",
        needs=("deployment",),
        many=True,
        docs="https://learn.microsoft.com/azure/ai-foundry/openai/api-version-lifecycle",
        checked="2026-11-21",
        note="v1 route: {endpoint}/openai/v1/chat/completions with the deployment as model. Older route: "
        "{endpoint}/openai/deployments/{deployment}/chat/completions?api-version=…, used when an api-version is set.",
    ),
    Kind(
        id="bedrock",
        label="AWS Bedrock",
        adapter="bedrock",
        auth="aws",
        base_url="",  # derived from the region: bedrock-runtime.<region>.amazonaws.com
        base_url_editable=False,
        list_models="ListFoundationModels",  # an AWS API on the bedrock control plane, not a path
        structured="per_model",  # Converse outputConfig.textFormat, for the models that support it
        needs=("region",),
        many=True,
        docs="https://docs.aws.amazon.com/bedrock/latest/userguide/structured-output.html",
        checked="2026-11-21",
        note="Converse API with the pod's AWS credentials; no key is stored.",
    ),
    Kind(
        id="mistral",
        label="Mistral",
        adapter="openai_compat",
        auth="bearer",
        base_url="https://api.mistral.ai/v1",
        base_url_editable=False,
        list_models="/models",
        structured="json_schema",
        docs="https://docs.mistral.ai/api/endpoint/models",
        checked="2026-11-21",
        note="Structured output: https://docs.mistral.ai/capabilities/structured-output/custom_structured_output/",
    ),
    Kind(
        id="xai",
        label="xAI",
        adapter="openai_compat",
        auth="bearer",
        base_url="https://api.x.ai/v1",
        base_url_editable=False,
        list_models="/models",
        structured="per_model",
        docs="https://docs.x.ai/developers/rest-api-reference/inference/models",
        checked="2026-11-21",
        note="Structured output: https://docs.x.ai/developers/model-capabilities/text/structured-outputs",
    ),
    Kind(
        id="custom",
        label="Custom OpenAI-compatible",
        adapter="openai_compat",
        auth="bearer",  # sent only when a key is saved
        base_url="",
        base_url_editable=True,
        list_models="/models",
        structured="unknown",
        many=True,
        note="vLLM, LM Studio, a gateway, or any provider not listed: enter its base URL (the part before /chat/completions).",
    ),
)

# Named in the plan and not yet verified against their docs, so not offered by name. Until then each one works
# through "custom" with its base URL. Append a Kind above once its four facts are checked.
NOT_YET_VERIFIED: tuple[str, ...] = ("DeepSeek", "Groq", "Cohere", "Perplexity", "Together AI", "Fireworks AI", "OpenRouter", "Ollama")

BY_ID: dict[str, Kind] = {k.id: k for k in KINDS}


def check_catalog() -> None:
    """Start-up and test check: an entry that is wrong here would mislead the admin page."""
    assert len(BY_ID) == len(KINDS), "duplicate provider kind"
    for k in KINDS:
        assert k.base_url == "" or k.base_url.startswith("https://"), k.id
        assert not k.base_url.endswith("/"), k.id
        assert k.id == "custom" or (k.docs.startswith("https://") and k.checked), f"{k.id}: cite the docs page and the date"
        assert set(k.needs) <= {"region", "deployment", "api_version"}, k.id


def kinds_out() -> list[dict[str, object]]:
    return [
        {
            "id": k.id,
            "label": k.label,
            "adapter": k.adapter,
            "auth": k.auth,
            "base_url": k.base_url,
            "base_url_editable": k.base_url_editable,
            "lists_models": bool(k.list_models),
            "structured": k.structured,
            "needs": list(k.needs),
            "takes_key": k.auth not in ("aws", "none"),
            "env_key": k.env_key,
            "many": k.many,
            "docs": k.docs,
            "note": k.note,
        }
        for k in KINDS
    ]
