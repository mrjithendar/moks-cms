"""Settings an admin can change from the web app (Admin → AI & SEO → Settings) instead of the deployment's
environment. See store.py for precedence and the API, registry.py for the field model, groups/ for the fields."""

from __future__ import annotations

from .groups import GROUPS
from .store import (
    REFRESH_SECONDS,
    TABLE,
    MemorySettingsStore,
    PgSettingsStore,
    SettingsInvalid,
    Stored,
    UnknownGroup,
    apply_live,
    effective,
    overview,
    save_group,
)

__all__ = [
    "GROUPS",
    "REFRESH_SECONDS",
    "TABLE",
    "MemorySettingsStore",
    "PgSettingsStore",
    "SettingsInvalid",
    "Stored",
    "UnknownGroup",
    "apply_live",
    "effective",
    "overview",
    "save_group",
]
