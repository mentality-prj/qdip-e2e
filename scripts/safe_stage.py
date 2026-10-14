"""Run private-source build/test commands without exposing raw output publicly.

Raw subprocess stdout/stderr stays in the ephemeral hosted runner's private temp
directory and is NEVER uploaded. Prints only an allowlisted stage status.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

ALLOWED = {
    "backend-install", "mongodb-integration", "mongodb-recovery",
    "backend-start", "backend-http", "rr-plugin-http", "backend-restart", "backend-restart-verify",
    "observatory-install", "observatory-lint", "observatory-typecheck",
    "observatory-unit", "observatory-build", "browser-install", "browser-e2e",
    "sdk-install", "sdk-e2e", "sdk-negative", "rr-auth-revocation", "test-report",
    "rr-actor-unit", "rr-actor-ruff", "core-quality", "observatory-format",
    # RR-only stages executed by scripts/run_real_e2e.sh; keep these explicit.
    "rr-complete-functional-http", "rr-economic-evidence-mac", "rr-http-metrics",
}

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("stage", choices=sorted(ALLOWED))
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("--cwd", default=".")
    parser.add_argument("--output", default="")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command
    if command[:1] == ["--"]:
        command = command[1:]
    if not command or args.timeout < 1 or args.timeout > 1800:
        return 2
    temp = os.environ.get("RUNNER_TEMP")
    if not temp or os.environ.get("GITHUB_ACTIONS") != "true":
        print("SAFE_STAGE=REJECTED", file=sys.stderr)
        return 2
    path = Path(temp) / f"qdip-{args.stage}.log"
    try:
        with path.open("wb") as log:
            completed = subprocess.run(
                command,
                cwd=args.cwd,
                stdout=log,
                stderr=subprocess.STDOUT,
                timeout=args.timeout,
                check=False,
                env=os.environ.copy(),
            )
        status = "PASS" if completed.returncode == 0 else "FAIL"
    except subprocess.TimeoutExpired:
        status = "TIMEOUT"
    except (OSError, ValueError):
        status = "INFRA_FAIL"
    if args.output:
        # Only the audited Chromium JSON result is copied into RUNNER_TEMP;
        # never upload it or echo its content to public Actions logs.
        try:
            if path.exists():
                Path(args.output).write_bytes(path.read_bytes())
        except OSError:
            status = "INFRA_FAIL"
    # Separate sanitized phase ledger for final TEST_FAIL vs INFRA_FAIL status.
    with (Path(temp) / "qdip-stage-results.jsonl").open("a", encoding="utf-8") as out:
        out.write(json.dumps({"stage": args.stage, "status": status}) + chr(10))
    print(f"QDIP_STAGE_{args.stage.upper().replace('-', '_')}={status}")
    return 0 if status == "PASS" else 1

if __name__ == "__main__":
    raise SystemExit(main())
