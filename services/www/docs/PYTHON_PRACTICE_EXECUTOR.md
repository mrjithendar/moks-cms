# Python practice: code execution sandbox

Moved on 2026-11-16 to [`moks-tech/practice-programming`](https://github.com/moks-tech/practice-programming),
`docs/PYTHON_PRACTICE_EXECUTOR.md`, with the executor (`executor/`), its sandbox images, the problem bank
(`problems/python/`) and the executor's manifests. That repository's CI builds, pushes and deploys them.

What stays here is the CMS side: the practice pages, the admin and the seeder (`src/lib/practice/`), which call the
executor over HTTP (`PRACTICE_EXECUTOR_URL`, `PRACTICE_EXECUTOR_TOKEN`) and load the problem catalog from
`PRACTICE_CATALOG_PATH` (default `content/python-practice/catalog.generated.json`). A site copies the catalog in
from the `practice-catalog` image (jithendar.com: `/app/practice/python/catalog.generated.json`).
