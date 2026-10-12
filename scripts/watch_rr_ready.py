"""Dispatch real RR PR #331 E2E from the E2E repo's own Actions token.

The Core repository's cross-repository PAT is optional for this fallback:
the independent watcher can read the private PR via QDIP_READ_TOKEN and
dispatch using its own GITHUB_TOKEN. No private source is checked out.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
from datetime import datetime, timezone
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

CORE = "qdip-ai/qdip-core"
WEB = "qdip-ai/qdip-web"
E2E = "qdip-ai/qdip-e2e"
PR_NUMBER = 331
STATE_PATH = ".state/rr-ready-watch.json"
WEB_REF = "feat/rr-source-import-economic-advice"
SUITE_REF = "test/rr-complete-e2e-only"
SHA = re.compile(r"[0-9a-f]{40}\Z")


def api(repo: str, path: str, token: str, *, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    request = Request(
        "https://api.github.com/repos/" + repo + "/" + path,
        data=data,
        method=method,
        headers={
            "Authorization": "Bearer " + token,
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
            "User-Agent": "qdip-rr-ready-watcher",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        with urlopen(request, timeout=20) as response:
            data = response.read()
            return json.loads(data) if data else {}
    except HTTPError as exc:
        if exc.code == 404:
            return None
        raise RuntimeError("GitHub API request failed, HTTP %s" % exc.code) from None


def branch_head(repo: str, branch: str, token: str) -> str:
    item = api(repo, "git/ref/heads/" + quote(branch, safe="/"), token)
    sha = (item or {}).get("object", {}).get("sha")
    if not isinstance(sha, str) or not SHA.fullmatch(sha):
        raise RuntimeError("Missing valid SHA for required E2E source")
    return sha


def main() -> None:
    assert os.environ.get("GITHUB_ACTIONS") == "true"
    assert os.environ.get("GITHUB_REPOSITORY") == E2E
    read_token = os.environ["QDIP_READ_TOKEN"]
    own_token = os.environ["GITHUB_TOKEN"]
    assert read_token and own_token, "Required watcher credential missing"

    pr = api(CORE, "pulls/%d" % PR_NUMBER, read_token)
    if not pr or pr["state"] != "open" or pr["draft"]:
        print("RR_READY_WATCH=NOT_READY")
        return
    branch = pr["head"]["ref"]
    core_sha = pr["head"]["sha"]
    assert pr["head"]["repo"]["full_name"] == CORE
    assert pr["base"]["ref"] == "dev"
    assert branch.startswith(("fix/rr-", "feat/rr-"))
    assert SHA.fullmatch(core_sha)
    web_sha = branch_head(WEB, WEB_REF, read_token)
    suite_sha = branch_head(E2E, SUITE_REF, own_token)

    key = hashlib.sha256(("%s:%s:%s" % (core_sha, web_sha, suite_sha)).encode()).hexdigest()
    state = api(E2E, "contents/" + STATE_PATH + "?ref=main", own_token)
    old = json.loads(base64.b64decode(state["content"])) if state else {}
    if old.get("key") == key:
        print("RR_READY_WATCH=ALREADY_DISPATCHED")
        return

    payload = {
        "event_type": "rr-pr-ready",
        "client_payload": {
            "pr_number": PR_NUMBER,
            "backend_sha": core_sha,
            "backend_branch": branch,
            "observatory_ref": WEB_REF,
            "observatory_sha": web_sha,
            "suite_ref": SUITE_REF,
            "suite_sha": suite_sha,
            "rr_contract_mode": "rr-oidc-session-v1",
        },
    }
    api(E2E, "dispatches", own_token, method="POST", body=payload)
    new_state = {
        "key": key, "core_sha": core_sha, "web_sha": web_sha,
        "suite_sha": suite_sha, "last_dispatched_utc": datetime.now(timezone.utc).isoformat(),
    }
    put = {
        "message": "ci(e2e): record RR PR-ready E2E dispatch",
        "branch": "main",
        "content": base64.b64encode((json.dumps(new_state, sort_keys=True, indent=2) + "\n").encode()).decode(),
    }
    if state:
        put["sha"] = state["sha"]
    api(E2E, "contents/" + STATE_PATH, own_token, method="PUT", body=put)
    print("RR_READY_WATCH=DISPATCHED")
    print("RR_READY_CORE_SHA=" + core_sha)
    print("RR_READY_WEB_SHA=" + web_sha)
    print("RR_READY_SUITE_SHA=" + suite_sha)


if __name__ == "__main__":
    main()
