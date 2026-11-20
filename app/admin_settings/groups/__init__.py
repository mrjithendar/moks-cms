"""One module per settings group. Add a group by adding a module here and appending its GROUP to GROUPS below
(append only: other sessions add groups too)."""

from __future__ import annotations

from ..registry import Group, check_registry
from . import agent_limits

GROUPS: list[Group] = [
    agent_limits.GROUP,
]

check_registry(GROUPS)
