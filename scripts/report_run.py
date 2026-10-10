"""Finalize SHA-pinned E2E outcomes in public-suite ledger, not private Core."""
import base64
import json
import os
from urllib.request import Request, urlopen

URL = "https://api.github.com/repos/mentality-prj/qdip-e2e/contents/.state/core-watch.json"


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
    terminal = "PASS" if os.environ.get("E2E_JOB_STATUS") == "success" else "INFRA_FAIL"
    data = exchange("GET", token)
    ledger = json.loads(base64.b64decode(data["content"]))
    state = ledger["branches"].get(branch, {})
    attempt = state.get("last_attempt", {})
    if attempt.get("backend_sha") != sha:
        raise RuntimeError("E2E completion does not match ledger")
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


if __name__ == "__main__":
    main()
