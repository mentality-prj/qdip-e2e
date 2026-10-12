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
import subprocess
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

API = "https://api.github.com"
CORE = "qdip-ai/qdip-core"
OBS = "qdip-ai/qdip-web"
TARGET = "qdip-ai/qdip-e2e"
# Only the canonical dev pair can qualify the current integrated product.
# Old feature branches remain preserved as historical records in the ledger.
BRANCHES = ("dev",)
OBS_BRANCHES = {"dev": "dev"}
LEDGER = ".state/core-watch.json"
RR_CONTRACT = "app/plugins/readiness_recovery/reference_proof.py"
RR_PLUGIN_PRESENTATION = "app/plugins/readiness_recovery/presentation.py"
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


def rr_contract_mode(core_sha: str, obs_sha: str, token: str) -> str:
    """Select strict contract tests from BOTH pinned Core and Web revisions.

    The OIDC data-plane gate uses a locally signed ephemeral session, not a
    synthetic claim of successful login at the real external Zitadel issuer.
    No authorization/network failure may downgrade an available Core contract.
    """
    try:
        item = api(f"/repos/{CORE}/contents/{RR_PLUGIN_PRESENTATION}?ref={core_sha}", token)
    except FileNotFoundError:
        return "legacy"
    if item.get("type") != "file":
        raise RuntimeError("Unsupported RR presentation resource type")
    path = "src/app/api/rr-operator/session/route.ts"
    web = api(f"/repos/{OBS}/contents/{path}?ref={obs_sha}", token)
    if web.get("type") != "file" or not isinstance(web.get("content"), str):
        raise RuntimeError("Missing Web RR authentication contract")
    import base64 as _base64

    code = _base64.b64decode(web["content"]).decode("utf-8")
    if "Password authentication retired; use Zitadel OIDC" in code:
        return "rr-oidc-session-v1"
    if "createOperatorSession" in code and "verifyOperatorPassword" in code:
        return "rr-plugin-v1"
    raise RuntimeError("Unknown Web RR authorization contract; no test-mode fallback")


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
    """Stable qualification identity from tracked source files only.

    The independent runner imports this module before verifying the dispatch,
    which generates scripts/__pycache__/*.pyc. Hashing all rglob() files made
    otherwise identical watcher and runner Git checkouts disagree. Git's
    tracked files are the canonical suite source of truth. Generated local
    reports and Python bytecode must NEVER alter an acceptance key.
    """
    digest = hashlib.sha256()
    root = Path(__file__).resolve().parents[1]
    selected = subprocess.check_output(
        [
            "git", "-C", str(root), "ls-files", "-z", "--",
            ".github/workflows/real-e2e.yml", "scripts", "fixtures",
        ],
        timeout=10,
    )
    files = sorted(item.decode("utf-8") for item in selected.split(b"\0") if item)
    if not files or ".github/workflows/real-e2e.yml" not in files:
        raise RuntimeError("E2E source fingerprint cannot find tracked runner files")
    for relative in files:
        path = root / relative
        if not path.is_file() or path.is_symlink():
            raise RuntimeError("E2E source fingerprint requires regular tracked files")
        digest.update(relative.encode("utf-8"))
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


def dispatch(branch: str, sha: str, obs_sha: str, token: str, mode: str,
             obs_branch: str, key: str, suite_sha: str) -> None:
    api(f"/repos/{TARGET}/dispatches", token,
        body={"event_type": "qdip-core-updated",
              "client_payload": {"repository": CORE, "backend_sha": sha, "backend_branch": branch,
                                 "observatory_ref": obs_branch, "observatory_sha": obs_sha,
                                 "suite_sha": suite_sha, "qualification_key": key,
                                 "rr_contract_mode": mode}})


def should_skip_unrelated(prior: dict, previous_sha: str | None, current_sha: str,
                          obs_sha: str, suite_sha: str, observed_suite: str,
                          token: str) -> bool:
    """Only skip irrelevant Core changes after a PASS on the same Web and suite."""
    attempt = prior.get("last_attempt", {})
    return bool(
        previous_sha and previous_sha != current_sha
        and attempt.get("status") == "PASS"
        and attempt.get("obs_sha") == obs_sha
        and attempt.get("suite_sha") == suite_sha
        and attempt.get("suite_fingerprint") == observed_suite
        and not relevant_changes(previous_sha, current_sha, token)
    )


def main() -> int:
    if os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("GITHUB_REPOSITORY") != TARGET:
        return 2
    source, target = os.environ.get("QDIP_READ_TOKEN"), os.environ.get("GITHUB_TOKEN")
    if not source or not target:
        print("QDIP_E2E_WATCH=MISSING_CREDENTIALS", file=sys.stderr)
        return 2
    observed_suite = fingerprint()
    suite_sha = os.environ.get("GITHUB_SHA", "")
    if not re.fullmatch(r"[a-f0-9]{40}", suite_sha):
        raise RuntimeError("Watcher suite SHA is not pinned")
    data, etag = read_ledger(target)
    updated = False
    now = datetime.now(UTC)
    for branch in BRANCHES:
        obs_branch = OBS_BRANCHES[branch]
        obs_sha = head(OBS, obs_branch, source)
        sha = head(CORE, branch, source)
        prior = data["branches"].get(branch, {})
        previous_sha = prior.get("seen_sha")
        attempt = prior.get("last_attempt", {})
        mode = rr_contract_mode(sha, obs_sha, source)
        # Web/dev now uses Zitadel, while Core/dev can still be pre-RR-plugin.
        # A missing Core presentation contract is not a compatible legacy
        # operator: never run retired password Chromium tests against OIDC.
        # Record this as an unsupported PAIR, not a successful qualification
        # or a real product regression.
        if mode == "legacy":
            if prior.get("seen_sha") != sha or prior.get("status") != "RR_PLUGIN_NOT_MERGED":
                data["branches"][branch] = {
                    **prior, "seen_sha": sha, "status": "RR_PLUGIN_NOT_MERGED",
                }
                updated = True
            print(f"QDIP_WATCH_PAIR_NOT_READY={branch}:RR_PLUGIN_NOT_MERGED")
            continue
        key = hashlib.sha256(f"{sha}:{obs_sha}:{suite_sha}:{observed_suite}:{mode}".encode()).hexdigest()
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
        elif should_skip_unrelated(prior, previous_sha, sha, obs_sha, suite_sha, observed_suite, source):
            data["branches"][branch] = {**prior, "seen_sha": sha, "status": "SKIPPED_UNRELATED"}
            updated = True
            print(f"QDIP_WATCH_UNRELATED={branch}")
            continue
        dispatch(branch, sha, obs_sha, target, mode, obs_branch, key, suite_sha)
        count = int(attempt.get("count", 0)) + 1 if attempt.get("key") == key else 1
        data["branches"][branch] = {"seen_sha": sha, "status": "DISPATCHED",
                                   "last_attempt": {"key": key, "backend_sha": sha, "obs_sha": obs_sha,
                                                    "suite_fingerprint": observed_suite, "suite_sha": suite_sha,
                                                    "rr_contract_mode": mode,
                                                    "status": "DISPATCHED",
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
