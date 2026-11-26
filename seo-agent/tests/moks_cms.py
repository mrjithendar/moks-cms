"""The web app (moks-cms) that the contract tests compare the agent with.

The agent reads and writes the web app's database and calls its callback API, and some tests check that both sides
still agree by reading the web app's source: its migrations, the callback server's route table and a few shared
constants. Since D-105 the agent is part of moks-cms (seo-agent/), so the web app is always the parent folder and these
tests run everywhere, CI included. MOKS_CMS_DIR still points them at another checkout (a wrong path is an error).
"""

from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]  # seo-agent/
REPO = ROOT.parent  # moks-cms


def _checkout() -> Path:
    env = os.environ.get("MOKS_CMS_DIR")
    path = Path(env) if env else REPO
    if not (path / "src" / "db" / "migrations").is_dir():
        raise RuntimeError(f"{path} is not a moks-cms checkout (no src/db/migrations)")
    return path


CHECKOUT = _checkout()


def www(rel: str) -> Path:
    """`<rel>` in the moks-cms checkout (the web app)."""
    return CHECKOUT / rel
