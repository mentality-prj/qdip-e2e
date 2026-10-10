"""Independent public E2E watcher: compare private Core refs, then dispatch exactly once.

Durable state lives as JSON in THIS public E2E repository, never the private Core.
No action is run in Core. Manual reruns remain available for failed tests.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

API = "https://api.github.com"
CORE = "mentality-prj/dzvin-intelligence-platform"
OBS = "mentality-prj/dip-observatory"
TARGET = "mentality-prj/qdip-e2e"
BRANCHES = ("feat/rr-prod-01-normalized-source-import", "dev")
OBS_BRANCH = "feat/rr-production-operator-boundary"
LEDGER = ".state/core-watch.json"
RR_CONTRACT = "app/plugins/readiness_recovery/reference_proof.py"
SOURCE_PREFIXES = ("app/", "tests/", "packages/", "examples/", "scripts/")
SOURCE_NAMES = {"pyproject.toml", "uv.lock", "poetry.lock", "requirements.txt"}
# Every E2E runner, fixture and check influences the test identity.
# The mutable .state ledger itself is intentionally excluded.


def api(path: str, token: str, *, body: dict | None = None, method: str | None = None) -> dict:
    raw = json.dumps(body, separators=(",", ":")).encode() if body is not None else None
    request = Request(API + path, data=raw, method=method or ("POST" if raw is not None else "GET"),
                      headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
                               "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28",
                               "User-Agent": "qdip-independent-poller"})
    try:
        with urlopen(request, timeout=20) as response:
            result = response.read()
            return json.loads(result) if result else {}
    except HTTPError as exc:
        if exc.code == 404:
            raise FileNotFoundError("GitHub resource not found") from None
        raise RuntimeError(f"GitHub API failed HTTP {exc.code}") from None
    except URLError:
        raise RuntimeError("GitHub API unavailable") from None


def head(repo: str, branch: str, token: str) -> str:
    result = api(f"/repos/{repo}/git/ref/heads/{quote(branch, safe='/')}", token)
    sha = result.get("object", {}).get("sha")
    if not isinstance(sha, str) or not re.fullmatch("[a-f0-9]{40}", sha):
        raise RuntimeError("Invalid branch SHA")
    return sha


def supported(sha: str, token: str) -> bool:
    try:
        item = api(f"/repos/{CORE}/contents/{RR_CONTRACT}?ref={sha}", token)
        return item.get("type") == "file"
    except FileNotFoundError:
        return False


def relevant_changes(previous: str | None, current: str, token: str) -> bool:
    if not previous or previous == current:
        return previous is None
    try:
        compare = api(f"/repos/{CORE}/compare/{previous}...{current}", token)
    except FileNotFoundError:
        return True  # force-pushed history: fail open for TEST scheduling
    if compare.get("status") != "ahead":
        return True
    files = compare.get("files", [])
    if compare.get("total_commits", 0) > 200 or len(files) >= 300:
        return True  # GitHub diff truncation must not hide source changes
    return any(isinstance(f, dict) and (
        str(f.get("filename", "")).startswith(SOURCE_PREFIXES)
        or f.get("filename") in SOURCE_NAMES
    ) for f in files)


def fingerprint() -> str:
    digest = hashlib.sha256()
    root = Path(__file__).resolve().parents[1]
    paths = [root / ".github/workflows/real-e2e.yml"]
    paths += sorted(path for path in (root / "scripts").rglob("*") if path.is_file())
    paths += sorted(path for path in (root / "fixtures").rglob("*") if path.is_file())
    for path in paths:
        relative = path.relative_to(root).as_posix()
        digest.update(relative.encode())
        digest.update(bytes([0]))
        digest.update(path.read_bytes())
        digest.update(bytes([0]))
    return digest.hexdigest()


def read_ledger(token: str) -> tuple[dict, str | None]:
    try:
        result = api(f"/repos/{TARGET}/contents/{quote(LEDGER, safe='/')}?ref=main", token)
    except FileNotFoundError:
        return {"version": 1, "branches": {}}, None
    decoded = base64.b64decode(str(result["content"]))
    data = json.loads(decoded)
    if data.get("version") != 1 or not isinstance(data.get("branches"), dict):
        raise RuntimeError("Unsupported E2E ledger version")
    return data, result["sha"]


def write_ledger(data: dict, existing_sha: str | None, token: str) -> None:
    payload = {"message": "ci(e2e): persist observed source SHAs and test attempts",
               "branch": "main",
               "content": base64.b64encode((json.dumps(data, sort_keys=True, indent=2) + "\n").encode()).decode()}
    if existing_sha:
        payload["sha"] = existing_sha
    api(f"/repos/{TARGET}/contents/{quote(LEDGER, safe='/')}", token, body=payload, method="PUT")


def dispatch(branch: str, sha: str, token: str) -> None:
    api(f"/repos/{TARGET}/dispatches", token,
        body={"event_type": "qdip-core-updated",
              "client_payload": {"repository": CORE, "backend_sha": sha, "backend_branch": branch,
                                 "observatory_ref": OBS_BRANCH}})


def main() -> int:
    if os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("GITHUB_REPOSITORY") != TARGET:
        return 2
    source, target = os.environ.get("QDIP_READ_TOKEN"), os.environ.get("GITHUB_TOKEN")
    if not source or not target:
        print("QDIP_E2E_WATCH=MISSING_CREDENTIALS", file=sys.stderr)
        return 2
    observed_suite = fingerprint()
    obs_sha = head(OBS, OBS_BRANCH, source)
    data, etag = read_ledger(target)
    updated = False
    now = datetime.now(UTC)
    for branch in BRANCHES:
        sha = head(CORE, branch, source)
        prior = data["branches"].get(branch, {})
        previous_sha = prior.get("seen_sha")
        attempt = prior.get("last_attempt", {})
        key = hashlib.sha256(f"{sha}:{obs_sha}:{observed_suite}".encode()).hexdigest()
        if not supported(sha, source):
            data["branches"][branch] = {**prior, "seen_sha": sha, "status": "UNSUPPORTED_RR"}
            updated = True
            print(f"QDIP_WATCH_UNSUPPORTED={branch}")
            continue
        if attempt.get("key") == key:
            status = attempt.get("status")
            if status in {"PASS", "TEST_FAIL", "INFRA_FAIL"}:
                print(f"QDIP_WATCH_ALREADY_RECORDED={branch}:{status}")
                continue
            if status == "DISPATCHED":
                sent = datetime.fromisoformat(attempt["requested_at"])
                if now - sent < timedelta(hours=6):
                    print(f"QDIP_WATCH_RUNNING={branch}")
                    continue
                if attempt.get("count", 1) >= 2:
                    attempt["status"] = "INFRA_FAIL"
                    data["branches"][branch] = {**prior, "last_attempt": attempt}
                    updated = True
                    print(f"QDIP_WATCH_INFRA_STALE={branch}")
                    continue
        elif previous_sha != sha and not relevant_changes(previous_sha, sha, source):
            data["branches"][branch] = {**prior, "seen_sha": sha, "status": "SKIPPED_UNRELATED"}
            updated = True
            print(f"QDIP_WATCH_UNRELATED={branch}")
            continue
        dispatch(branch, sha, target)
        count = int(attempt.get("count", 0)) + 1 if attempt.get("key") == key else 1
        data["branches"][branch] = {"seen_sha": sha, "status": "DISPATCHED",
                                   "last_attempt": {"key": key, "backend_sha": sha, "obs_sha": obs_sha,
                                                    "suite_fingerprint": observed_suite, "status": "DISPATCHED",
                                                    "count": count, "requested_at": now.isoformat()}}
        updated = True
        print(f"QDIP_WATCH_DISPATCHED={branch}")
    if updated:
        write_ledger(data, etag, target)
    else:
        print("QDIP_WATCH_NO_NEW_WORK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
