"""Every schema sent as a structured output must let the model say something.

`AnthropicLlm.structured` calls `messages.parse(output_format=Schema)`, which sends the strict JSON schema the SDK
derives from the Pydantic model. A free-form object (`dict[str, Any]`, `dict[str, str]`) becomes
`{"type": "object", "properties": {}, "additionalProperties": false}`: the only valid answer is `{}`. That silently
emptied every topic label (TopicLabels.items) from the day structured outputs were switched on until 2026-11-24, so the
news topic classifier never trained and content flows found every story "off-topic".

The schemas are found in the code (every `.structured(spec, Name)` call), so a new one is checked without editing this
file.
"""

from __future__ import annotations

import importlib
import pathlib
import re
from typing import Any

import pytest
from anthropic.lib._parse._transform import transform_schema
from pydantic import BaseModel

APP = pathlib.Path(__file__).resolve().parents[1] / "app"
CALL = re.compile(r"\.structured\(\s*[\w.]+\s*,\s*([A-Z]\w*)\s*\)")


def _structured_schemas() -> dict[str, type[BaseModel]]:
    found: dict[str, type[BaseModel]] = {}
    for path in APP.rglob("*.py"):
        text = path.read_text()
        names = set(CALL.findall(text))
        if not names:
            continue
        module = importlib.import_module(".".join(path.relative_to(APP.parent).with_suffix("").parts))
        for name in names:
            obj = getattr(module, name, None)
            if isinstance(obj, type) and issubclass(obj, BaseModel):
                found[f"{module.__name__}.{name}"] = obj
    return found


def _empty_objects(node: Any, path: str = "$") -> list[str]:
    out: list[str] = []
    if isinstance(node, dict):
        if node.get("type") == "object" and node.get("properties") == {} and node.get("additionalProperties") is False:
            out.append(path)
        for k, v in node.items():
            out += _empty_objects(v, f"{path}.{k}")
    elif isinstance(node, list):
        for i, v in enumerate(node):
            out += _empty_objects(v, f"{path}[{i}]")
    return out


SCHEMAS = _structured_schemas()


def test_the_scan_finds_the_known_structured_outputs() -> None:
    names = {n.rsplit(".", 1)[1] for n in SCHEMAS}
    assert {"TopicLabels", "StyleProposal", "ImageVerdict", "JudgeVerdict"} <= names


@pytest.mark.parametrize("name", sorted(SCHEMAS))
def test_no_structured_output_has_an_object_the_model_cannot_fill(name: str) -> None:
    assert _empty_objects(transform_schema(SCHEMAS[name])) == [], f"{name}: type these fields with a model, not dict[...]"


def test_topic_labels_round_trip_through_the_strict_schema() -> None:
    from app.news.schemas import TopicLabels

    schema = transform_schema(TopicLabels)
    item = schema["properties"]["items"]["items"]
    item = schema.get("$defs", {}).get(item["$ref"].rsplit("/", 1)[1], item) if "$ref" in item else item
    assert set(item["properties"]) == {"i", "topics"}
    got = TopicLabels.model_validate({"items": [{"i": 0, "topics": ["kubernetes", "mlops"]}]})
    assert got.items[0].i == 0 and got.items[0].topics == ["kubernetes", "mlops"]
