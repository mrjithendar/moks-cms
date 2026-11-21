"""The schedules' cron evaluator (app/cron.py; it moved out of app/news when the news desk became its own service)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from app.cron import Cron, CronError


def test_cron_in_a_time_zone() -> None:
    c = Cron("0 7 * * 1-5", "Asia/Kolkata")  # 07:00 IST = 01:30 UTC
    nxt = c.next_after(datetime(2026, 11, 10, 2, 0, tzinfo=UTC))  # Tuesday 07:30 IST
    assert nxt == datetime(2026, 11, 11, 1, 30, tzinfo=UTC)
    assert c.next_after(datetime(2026, 11, 13, 2, 0, tzinfo=UTC)) == datetime(2026, 11, 16, 1, 30, tzinfo=UTC)  # Fri → Mon


def test_cron_steps_lists_and_due_window() -> None:
    c = Cron("*/15 6,18 * * *", "UTC")
    assert c.matches(datetime(2026, 11, 10, 18, 45, tzinfo=UTC)) and not c.matches(datetime(2026, 11, 10, 17, 45, tzinfo=UTC))
    now = datetime(2026, 11, 10, 6, 7, tzinfo=UTC)
    assert c.last_due(now, timedelta(minutes=16)) == datetime(2026, 11, 10, 6, 0, tzinfo=UTC)
    assert c.last_due(datetime(2026, 11, 10, 12, 0, tzinfo=UTC), timedelta(minutes=16)) is None
    assert Cron("0 9 * * 7", "UTC").matches(datetime(2026, 11, 15, 9, 0, tzinfo=UTC))  # 7 = Sunday


@pytest.mark.parametrize("bad", ["* * *", "61 * * * *", "0 25 * * *", "*/0 * * * *", "x * * * *"])
def test_cron_rejects(bad: str) -> None:
    with pytest.raises(CronError):
        Cron(bad, "UTC")
    with pytest.raises(CronError):
        Cron("0 7 * * *", "Mars/Olympus")

