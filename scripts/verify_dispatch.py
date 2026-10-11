"""Require dispatched private Core commit to be reachable from its declared branch."""
from __future__ import annotations

import json
import os
import re
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

REPO = "qdip-ai/qdip-core"
BRANCH_TO_WEB = {
    "dev": "dev",
    "feat/rr-plugin-computation-ownership": "feat/qdip-zitadel-oidc",
}

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

def main() -> None:
    source_sha = os.environ["BACKEND_SHA"]
    branch = os.environ["BACKEND_BRANCH"]
    token = os.environ["QDIP_READ_TOKEN"]
    web_ref = os.environ.get("OBSERVATORY_REF", "")
    if branch not in BRANCH_TO_WEB or web_ref != BRANCH_TO_WEB.get(branch):
        raise RuntimeError("Rejected mismatched Core/Web qualification pair")
    if branch not in BRANCH_TO_WEB or not re.fullmatch(r"[0-9a-f]{40}", source_sha):
        raise RuntimeError("Rejected source branch or commit format")
    ref = get(f"/repos/{REPO}/git/ref/heads/{quote(branch, safe='/')}", token)
    target_sha = ref.get("object", {}).get("sha")
    if not isinstance(target_sha, str) or not re.fullmatch(r"[0-9a-f]{40}", target_sha):
        raise RuntimeError("Missing source branch HEAD")
    if source_sha != target_sha:
        compare = get(f"/repos/{REPO}/compare/{source_sha}...{target_sha}", token)
        if compare.get("status") != "ahead" or compare.get("behind_by") != 0:
            raise RuntimeError("Dispatched SHA is not an ancestor of the source branch")
    print("QDIP_DISPATCH_SOURCE_PROVENANCE=PASS")

if __name__ == "__main__":
    main()
