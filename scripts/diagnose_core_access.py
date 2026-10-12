"""Credential diagnostics without logging tokens, identities or private data.

This workflow is isolated to a disposable public Actions runner.
Outputs ONLY endpoint status categories. Never prints response bodies or SHA.
"""
from __future__ import annotations

import os
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

HOST = "https://api.github.com"
PROBES = (
    ("AUTHENTICATED_ACTOR", "/user"),
    ("PUBLIC_WEB_REPOSITORY", "/repos/qdip-ai/qdip-web"),
    ("PRIVATE_CORE_REPOSITORY", "/repos/qdip-ai/qdip-core"),
    ("PRIVATE_CORE_DEV_REF", "/repos/qdip-ai/qdip-core/git/ref/heads/dev"),
    ("PRIVATE_CORE_SOURCE", "/repos/qdip-ai/qdip-core/contents/pyproject.toml?ref=dev"),
)


def status(path: str, secret: str) -> int:
    request = Request(
        HOST + path,
        headers={
            "Authorization": "Bearer " + secret,
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "qdip-private-core-access-diag",
        },
    )
    try:
        with urlopen(request, timeout=12) as response:
            return response.status
    except HTTPError as exc:
        return exc.code
    except URLError:
        return 0


def classification(results: dict[str, int]) -> str:
    if results.get("AUTHENTICATED_ACTOR") != 200:
        return "TOKEN_INVALID_EXPIRED_OR_NOT_AUTHENTICATED"
    if results.get("PRIVATE_CORE_REPOSITORY") != 200:
        return "CORE_NOT_VISIBLE_TO_THIS_ACTIONS_SECRET"
    if results.get("PRIVATE_CORE_DEV_REF") != 200:
        return "CORE_VISIBLE_BUT_DEV_REF_NOT_READABLE"
    if results.get("PRIVATE_CORE_SOURCE") != 200:
        return "CORE_REF_VISIBLE_BUT_CONTENTS_NOT_READABLE"
    return "PASS"


def main() -> int:
    if os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("GITHUB_REPOSITORY") != "qdip-ai/qdip-e2e":
        print("QDIP_CORE_ACCESS_DIAGNOSTIC=REFUSED_NON_ACTIONS_RUNNER")
        return 2
    secret = os.environ.get("QDIP_READ_TOKEN", "")
    if not secret:
        print("QDIP_CORE_ACCESS_DIAGNOSTIC=SECRET_MISSING_IN_E2E_ACTIONS")
        return 2

    results: dict[str, int] = {}
    for label, path in PROBES:
        results[label] = status(path, secret)
        # Numeric HTTP codes only: no private content, token, URL, username,
        # scopes, endpoint payloads or response headers are logged.
        print(f"QDIP_{label}_HTTP={results[label]}")
    verdict = classification(results)
    print(f"QDIP_CORE_ACCESS_DIAGNOSTIC={verdict}")
    return 0 if verdict == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
