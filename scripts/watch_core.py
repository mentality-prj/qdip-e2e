"""Observe private QDIP Git commits from the E2E repository, never from Core CI.

Runs only in qdip-e2e GitHub Actions. Sends repository_dispatch for eligible new
commits; completed attempt markers suppress repeated costly runs. This is not
a security/production qualification of the source commits.
"""

from __future__ import annotations

import json
import os
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

API = "https://api.github.com"
CORE = "mentality-prj/dzvin-intelligence-platform"
TARGET = "mentality-prj/qdip-e2e"
BRANCHES = ("feat/rr-prod-01-normalized-source-import", "dev")
REQUIRED_REF_PROOF = "app/plugins/readiness_recovery/reference_proof.py"
EVENT_TYPE = "qdip-core-updated"


def github_request(path: str, token: str, *, payload: dict[str, object] | None = None) -> dict[str, object]:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = Request(
        API + path,
        data=data,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "qdip-independent-e2e-poller",
            **({"Content-Type": "application/json"} if data is not None else {}),
        },
        method="POST" if data is not None else "GET",
    )
    try:
        with urlopen(request, timeout=20) as response:
            if response.status not in (200, 201, 204):
                raise RuntimeError(f"GitHub API unexpected HTTP {response.status}")
            raw = response.read()
            return json.loads(raw) if raw else {}
    except HTTPError as error:
        if error.code == 404:
            raise FileNotFoundError("Requested private repository resource not found") from None
        raise RuntimeError(f"GitHub API HTTP {error.code} when accessing {path.split('?')[0]}") from None
    except URLError as error:
        raise RuntimeError("GitHub API unreachable") from error


def branch_head(branch: str, token: str) -> str:
    ref = quote(f"heads/{branch}", safe="/")
    response = github_request(f"/repos/{CORE}/git/ref/{ref}", token)
    obj = response.get("object")
    sha = obj.get("sha") if isinstance(obj, dict) else None
    if not isinstance(sha, str) or not re.fullmatch("[0-9a-f]{40}", sha):
        raise RuntimeError("Unexpected source ref SHA")
    return sha


def is_supported_build(sha: str, token: str) -> bool:
    path = quote(REQUIRED_REF_PROOF, safe="/")
    try:
        result = github_request(f"/repos/{CORE}/contents/{path}?ref={sha}", token)
    except FileNotFoundError:
        return False
    return result.get("type") == "file"


def already_attempted(sha: str, token: str) -> bool:
    name = f"qdip-e2e-attempt-{sha}"
    response = github_request(
        f"/repos/{TARGET}/actions/artifacts?per_page=10&name={name}",
        token,
    )
    artifacts = response.get("artifacts", [])
    if not isinstance(artifacts, list):
        raise RuntimeError("Malformed GitHub Actions artifacts list")
    return any(isinstance(item, dict) and item.get("name") == name and not item.get("expired") for item in artifacts)


def dispatch(branch: str, sha: str, token: str) -> None:
    github_request(
        f"/repos/{TARGET}/dispatches",
        token,
        payload={
            "event_type": EVENT_TYPE,
            "client_payload": {
                "repository": CORE,
                "backend_sha": sha,
                "backend_branch": branch,
                "observatory_ref": "feat/rr-production-operator-boundary",
            },
        },
    )


def main() -> int:
    if os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("GITHUB_REPOSITORY") != TARGET:
        print("QDIP_E2E_WATCH=REJECTED_WRONG_ENVIRONMENT", file=sys.stderr)
        return 2
    source_token = os.environ.get("QDIP_READ_TOKEN", "")
    target_token = os.environ.get("GITHUB_TOKEN", "")
    if not source_token or not target_token:
        print("QDIP_E2E_WATCH=MISSING_READ_OR_DISPATCH_TOKEN", file=sys.stderr)
        return 2
    dispatched = set()
    for branch in BRANCHES:
        sha = branch_head(branch, source_token)
        # Do not run pre-RR dev branches lacking the tested reference contract.
        if not is_supported_build(sha, source_token):
            print(f"QDIP_E2E_WATCH_UNSUPPORTED_BRANCH={branch}")
            continue
        if sha in dispatched or already_attempted(sha, target_token):
            print(f"QDIP_E2E_WATCH_UNCHANGED={branch}@{sha}")
            continue
        dispatch(branch, sha, target_token)
        dispatched.add(sha)
        print(f"QDIP_E2E_WATCH_DISPATCHED={branch}@{sha}")
    if not dispatched:
        print("QDIP_E2E_WATCH=NO_NEW_BUILD")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
