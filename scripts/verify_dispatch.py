"""Verify the exact dispatched Core/Web/E2E qualification identity.

No branch ref may be silently substituted for the SHA chosen by the watcher.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

from watch_core import fingerprint

CORE = "qdip-ai/qdip-core"
WEB = "qdip-ai/qdip-web"
BRANCH_TO_WEB = {"dev": "dev"}
SHA = re.compile(r"[0-9a-f]{40}\Z")
KEY = re.compile(r"[0-9a-f]{64}\Z")


def get(path: str, token: str) -> dict:
    request = Request(
        "https://api.github.com" + path,
        headers={"Authorization": f"Bearer {token}",
                 "Accept": "application/vnd.github+json",
                 "X-GitHub-Api-Version": "2022-11-28",
                 "User-Agent": "qdip-e2e-integrity"},
    )
    try:
        with urlopen(request, timeout=15) as response:
            return json.load(response)
    except HTTPError as exc:
        raise RuntimeError(f"Source verification GitHub HTTP {exc.code}") from None


def require_reachable(repo: str, branch: str, sha: str, token: str) -> None:
    if not SHA.fullmatch(sha):
        raise RuntimeError("Source revision must be an immutable SHA")
    ref = get(f"/repos/{repo}/git/ref/heads/{quote(branch, safe='/')}", token)
    tip = ref.get("object", {}).get("sha")
    if not isinstance(tip, str) or not SHA.fullmatch(tip):
        raise RuntimeError("Missing source branch HEAD")
    if sha != tip:
        compare = get(f"/repos/{repo}/compare/{sha}...{tip}", token)
        if compare.get("status") != "ahead" or compare.get("behind_by") != 0:
            raise RuntimeError("Dispatched SHA is not an ancestor of its source branch")


def main() -> None:
    core_sha = os.environ["BACKEND_SHA"]
    branch = os.environ["BACKEND_BRANCH"]
    web_sha = os.environ["OBSERVATORY_SHA"]
    web_branch = os.environ["OBSERVATORY_REF"]
    suite_sha = os.environ["E2E_SUITE_SHA"]
    key = os.environ["QUALIFICATION_KEY"]
    mode = os.environ["RR_E2E_CONTRACT_MODE"]
    token = os.environ["QDIP_READ_TOKEN"]
    if branch not in BRANCH_TO_WEB or web_branch != BRANCH_TO_WEB[branch]:
        raise RuntimeError("Rejected mismatched Core/Web qualification pair")
    if not SHA.fullmatch(suite_sha) or not KEY.fullmatch(key):
        raise RuntimeError("Missing pinned E2E revision or qualification identity")
    checked_out = subprocess.check_output(
        ["git", "-C", "suite", "rev-parse", "HEAD"], text=True, timeout=10
    ).strip()
    if checked_out != suite_sha:
        raise RuntimeError("Running E2E suite differs from dispatched suite SHA")
    expected = hashlib.sha256(
        f"{core_sha}:{web_sha}:{suite_sha}:{fingerprint()}:{mode}".encode()
    ).hexdigest()
    if expected != key:
        raise RuntimeError("Runner/ledger qualification identity mismatch")
    require_reachable(CORE, branch, core_sha, token)
    require_reachable(WEB, web_branch, web_sha, token)
    print("QDIP_DISPATCH_CORE_WEB_E2E_PROVENANCE=PASS")


if __name__ == "__main__":
    main()
