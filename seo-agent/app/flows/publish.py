"""publish_flow: started **only** by a human approval (POST /review/{draft_id}/decision, approve).

    apply_changes → cms_publish ─┬─ refused ───────────────────────────────→ publish_failed
                                 └─ verify_live ─┬─ passed → submit_search → reindex → schedule_measure (published)
                                                 └─ failed (3 attempts) → alert + one-click rollback offer (verify_failed)

Two independent gates (D-58):
1. The run manager accepts `publish_flow` only from the review decision endpoint (`triggered_by="approval"`); the
   generic kickoff API, CronJob triggers, flows and every MCP tool are refused (app/flows/__init__.py, tests).
2. The web app's `publishWithApproval` (v3 D-43) publishes only for an approval an admin recorded in the review UI:
   unused, unexpired, for this draft, with exactly these accepted change ids, approver still admin. The approval is
   consumed before anything is written, so it works once.

Edits are the reviewer's per-change edits; the web app has already stored them on the draft and refuses a publish
whose edits differ from what is stored.
"""

from __future__ import annotations

from functools import partial
from typing import Any, ClassVar

from crewai.flow import listen, persist, router, start

from ..runs import INSTANCE_ONLY
from ..state import PublishState
from ..webapp import WebAppError
from .base import SeoFlow


@persist(INSTANCE_ONLY)
class PublishFlow(SeoFlow[PublishState]):
    FLOW: ClassVar[str] = "publish_flow"

    @start()
    async def apply_changes(self) -> None:
        async with self.step("apply_changes"):
            s = self.state
            if s.triggered_by != "approval":
                # Defence in depth: the runner already refuses this; a flow must never publish on any other trigger.
                raise PermissionError("publish_flow runs only from a human approval")
            unknown = sorted(set(s.edits) - set(s.accepted_change_ids))
            if not s.accepted_change_ids or unknown:
                s.outcome = "publish_failed"
                s.errors.append("no accepted changes" if not s.accepted_change_ids else f"edits for changes that are not accepted: {', '.join(unknown[:5])}")
                return
            d = await self.retry(lambda: self.deps.web.draft_summary(s.draft_id))
            s.article_id = d.get("articleId")

    @router(apply_changes)
    def after_apply(self) -> str:
        return "to_stop" if self.state.outcome == "publish_failed" else "to_publish"

    @listen("to_publish")
    async def cms_publish(self) -> None:
        async with self.step("cms_publish"):
            s = self.state
            saw_transient = False

            async def attempt() -> dict[str, Any]:
                nonlocal saw_transient
                try:
                    return dict(await self.deps.web.publish(s.draft_id, s.approval_id, s.accepted_change_ids, s.edits))
                except WebAppError as e:
                    saw_transient = saw_transient or e.transient
                    raise

            try:
                r = await self.retry(attempt)
            except WebAppError as e:
                if e.transient:
                    raise
                # A transient failure (timeout, 5xx) may have hidden a publish that committed; the retry then meets the
                # used approval. The web app replays the result for the Idempotency-Key; an older web app answers 403,
                # so check the draft before calling this a failure.
                if saw_transient and await self._published_by_this_approval():
                    s.publish_result = {"ok": True, "status": "published", "recovered": True}
                    return
                s.publish_result = {"ok": False, "status": e.status, "error": e.message}
                s.errors.append(f"publish: {e.message}")
                s.outcome = "publish_failed"
                return
            s.publish_result = {"ok": True, **r}

    async def _published_by_this_approval(self) -> bool:
        s = self.state
        for i in range(3):
            try:
                d = await self.retry(lambda: self.deps.web.draft_summary(s.draft_id))
            except WebAppError:
                return False
            status = d.get("status")
            if status == "published":
                by = d.get("publishedApprovalId")
                return by is None or str(by) == s.approval_id  # None: a web app without the field
            if status != "publishing" or i == 2:
                return False
            await self.deps.sleep(5.0)  # the first attempt is still writing
        return False

    @router(cms_publish)
    def after_publish(self) -> str:
        return "to_verify" if self.state.publish_result.get("ok") else "to_stop"

    @listen("to_verify")
    async def verify_live(self) -> None:
        async with self.step("verify_live"):
            s = self.state
            n = len(self.deps.verify_delays)
            last: dict[str, object] = {}
            for attempt, delay in enumerate(self.deps.verify_delays, start=1):
                await self.deps.sleep(delay)  # the other replica's content cache lives 30 s
                last = await self.retry(partial(self.deps.web.verify, s.draft_id, attempt, final=attempt == n))
                if last.get("state") == "passed":
                    break
            s.verification = dict(last)

    @router(verify_live)
    def after_verify(self) -> str:
        return "to_submit" if self.state.verification.get("state") == "passed" else "to_verify_failed"

    @listen("to_verify_failed")
    async def offer_rollback(self) -> None:
        async with self.step("offer_rollback"):
            # final=True already made the web app audit the failure and send the alert with the one-click rollback
            # link; nothing is submitted to search engines.
            self.state.outcome = "verify_failed"
            self.state.errors.append("live verification failed; rollback offered")

    @listen("to_submit")
    async def submit_search(self) -> None:
        async with self.step("submit_search"):
            s = self.state
            s.submission_results = await self.retry(lambda: self.deps.web.submit(s.draft_id))

    @listen(submit_search)
    async def reindex(self) -> None:
        async with self.step("reindex"):
            s = self.state
            if not (self.deps.reindex and s.article_id):
                return
            try:
                s.reindex = await self.deps.reindex([s.article_id], False)  # incremental: only changed chunks
            except Exception as e:  # the page is live and submitted; a stale index is not a publish failure
                s.errors.append(f"reindex: {type(e).__name__}")

    @listen(reindex)
    async def schedule_measure(self) -> None:
        async with self.step("schedule_measure"):
            # The web app's daily outcomes job captures +28/+56-day metrics against the baseline stored at publish.
            self.state.measurement = {"by": "web outcomes job", "windows_days": [28, 56]}
            self.state.outcome = "published"

    @listen("to_stop")
    async def stop(self) -> None:
        async with self.step("stop"):
            self.state.outcome = self.state.outcome or "publish_failed"
