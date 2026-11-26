"""chromadb stays installed only because crewai imports it at load (DECISIONS.md D-47, D-53). Its open advisories
(GHSA-f4j7-r4q5-qw2c, GHSA-2wm9-hf6c-p5cr, GHSA-xph7-9rjv-w5fr, GHSA-36p7-vc44-83pf) are all in the Chroma server and its
auth providers, which the Dockerfile deletes from the image. This test fails if any service module starts importing
one of them, which would also break the image at runtime.
"""

import importlib
import pkgutil
import sys

import app

# Removed from the image by the Dockerfile; never imported by the service.
REMOVED = ("chromadb_rust_bindings", "chromadb.server", "chromadb.cli", "chromadb.app", "chromadb.auth.basic_authn", "chromadb.auth.simple_rbac_authz")


def test_service_never_imports_the_chroma_server_or_its_auth_providers() -> None:
    for module in pkgutil.walk_packages(app.__path__, "app."):
        importlib.import_module(module.name)
    loaded = sorted(name for name in sys.modules if any(name == r or name.startswith(r + ".") for r in REMOVED))
    assert loaded == [], f"imports chromadb server code that the image does not contain: {loaded}"
