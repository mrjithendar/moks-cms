"""Weekly CronJob entrypoint: ask the running seo-agent for an incremental reindex, then let the Istio sidecar exit.

  python -m app.reindex_job            # incremental (changed chunks only)
  python -m app.reindex_job --full     # everything (model change)

The work happens in the service (one place holds the model and the lock); this job is only the scheduler's trigger.
In the mesh, a Job's sidecar would keep the pod running after the container exits, so the job calls the sidecar's
/quitquitquit endpoint at the end (harmless without a sidecar).
"""

from __future__ import annotations

import json
import os
import sys

import httpx


def main(argv: list[str]) -> int:
    full = "--full" in argv
    url = os.environ.get("SEO_AGENT_URL", "http://seo-agent.jithendar:8080").rstrip("/")
    token = os.environ.get("SEO_AGENT_TOKEN", "")
    code = 0
    try:
        r = httpx.post(f"{url}/embeddings/reindex", json={"full": full}, headers={"Authorization": f"Bearer {token}"}, timeout=1800)
        print(json.dumps({"event": "reindex", "status": r.status_code, "result": r.json() if r.content else None}))
        code = 0 if r.status_code in (200, 409) else 1  # 409: a reindex is already running (Forbid semantics)
    except httpx.HTTPError as e:
        print(json.dumps({"event": "reindex", "error": type(e).__name__}))
        code = 1
    finally:
        try:
            httpx.post("http://127.0.0.1:15020/quitquitquit", timeout=5)
        except httpx.HTTPError:
            pass
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
