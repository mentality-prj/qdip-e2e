"""Finalize SHA-pinned E2E outcomes in public-suite ledger, not private Core."""
import base64
import json
import os
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

URL = "https://api.github.com/repos/qdip-ai/qdip-e2e/contents/.state/core-watch.json"


def exchange(method, token, payload=None):
    body = json.dumps(payload).encode() if payload else None
    req = Request(URL, method=method, data=body, headers={
        "Authorization": "Bearer " + token, "Accept": "application/vnd.github+json",
        "Content-Type": "application/json", "User-Agent": "qdip-e2e-finalizer"})
    with urlopen(req, timeout=25) as res:
        return json.load(res)


def main():
    token = os.environ["GITHUB_TOKEN"]
    branch = os.environ["E2E_BRANCH"]
    sha = os.environ["E2E_SHA"]
    statuses_file = Path(os.environ.get("E2E_PHASES_PATH") or str(Path(os.environ["RUNNER_TEMP"]) / "qdip-stage-results.jsonl"))
    observed = []
    if statuses_file.exists():
        for line in statuses_file.read_text(encoding="utf-8").splitlines():
            observed.append(json.loads(line))
    failing = next((x["stage"] for x in observed if x["status"] != "PASS"), None)
    expected_test_stages = {
        "mongodb-integration", "mongodb-recovery", "backend-http", "rr-plugin-http",
        "backend-restart-verify", "observatory-unit", "sdk-e2e", "sdk-negative", "rr-auth-revocation", "browser-e2e", "test-report",
    }
    terminal = ("PASS" if os.environ.get("E2E_JOB_STATUS") == "success" else
                "TEST_FAIL" if failing in expected_test_stages else "INFRA_FAIL")
    for retry in range(4):
        try:
            data = exchange("GET", token)
            ledger = json.loads(base64.b64decode(data["content"]))
            state = ledger["branches"].get(branch, {})
            attempt = state.get("last_attempt", {})
            if attempt.get("backend_sha") != sha:
                raise RuntimeError("E2E completion does not match current ledger")
            attempt["status"] = terminal
            attempt["run_id"] = os.environ["GITHUB_RUN_ID"]
            state["last_attempt"] = attempt
            state["status"] = terminal
            ledger["branches"][branch] = state
            exchange("PUT", token, {
                "message": "ci(e2e): store terminal test result",
                "branch": "main",
                "sha": data["sha"],
                "content": base64.b64encode((json.dumps(ledger, sort_keys=True) + chr(10)).encode()).decode(),
            })
            print("QDIP_E2E_STATE=" + terminal)
            return
        except HTTPError as exc:
            if exc.code not in (409, 422) or retry == 3:
                raise RuntimeError("Durable E2E result update failed") from None
            time.sleep(1)


if __name__ == "__main__":
    main()
