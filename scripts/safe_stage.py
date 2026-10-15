"""Run private-source build/test commands without exposing raw output publicly.

Raw subprocess stdout/stderr stays in the ephemeral hosted runner's private temp
directory and is NEVER uploaded. Prints only an allowlisted stage status.
"""
from __future__ import annotations

import argparse
import json
import os
import re
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
    if args.stage == "mongodb-recovery" and status == "PASS":
        # This specific runner restores only an invented database on a loopback
        # native Mongo replica. Publish bounded numbers/statuses, never the
        # private backup, signing keys, application stdout or stack traces.
        source = path.read_text(encoding="utf-8", errors="replace")
        rto_values = re.findall(
            r"^RR_NATIVE_DISPOSABLE_RESTORE_RTO_MS=([0-9]{1,9})$",
            source,
            flags=re.MULTILINE,
        )
        accepted = (
            len(rto_values) == 1
            and source.count(
                "RR_NATIVE_DISPOSABLE_RPO_LOST_RECORDS=0 "
                "(fixed synthetic five-collection fixture only)"
            ) == 1
            and "RR_RECOVERY_ECONOMIC_HMAC_TAMPER=PASS" in source
            and "RR_NATIVE_REAL_BACKUP_RESTORE=PASS " in source
        )
        if not accepted:
            # No silent scope-limited PASS if RTO/RPO or HMAC drill metrics
            # disappear, become ambiguous, or are not independently verified.
            status = "FAIL"
            print("QDIP_RECOVERY_METRICS=FAIL")
        else:
            print("RR_DISPOSABLE_RESTORE_RTO_MS=" + rto_values[0])
            print("RR_DISPOSABLE_RPO_LOST_RECORDS=0")
            print("RR_DISPOSABLE_HMAC_ARCHIVE_INTEGRITY=PASS")
            print("QDIP_RECOVERY_METRICS=PASS")
    # Separate sanitized phase ledger for final TEST_FAIL vs INFRA_FAIL status.
    with (Path(temp) / "qdip-stage-results.jsonl").open("a", encoding="utf-8") as out:
        out.write(json.dumps({"stage": args.stage, "status": status}) + chr(10))
    if args.stage == "mongodb-recovery" and status != "PASS" and path.exists():
        # Safe only for the synthetic hard-coded local RR restore verifier.
        # Never release unfiltered backend stderr or payloads into public Actions.
        source = path.read_text(encoding="utf-8", errors="replace")
        phases = re.findall(
            r"^RR_RECOVERY_PHASE=(SEED_START|BASE_SEED|ECONOMIC_SEED_OLD|"
            r"ECONOMIC_SEED_ROTATED|BASE_VERIFY|ECONOMIC_VERIFY|"
            r"VERIFY_START|TAMPER_START)$",
            source,
            flags=re.MULTILINE,
        )
        kinds = re.findall(
            r"^RR_RECOVERY_ERROR_CLASS=(ValidationError|TypeError|ValueError|"
            r"RuntimeError|ImportError|ModuleNotFoundError|AssertionError|"
            r"KeyError|AttributeError|OperationFailure|OTHER)$",
            source,
            flags=re.MULTILINE,
        )
        print("QDIP_RECOVERY_LAST_PHASE=" + (phases[-1] if phases else "UNKNOWN"))
        print("QDIP_RECOVERY_ERROR_CLASS=" + (kinds[-1] if kinds else "UNKNOWN"))
    print(f"QDIP_STAGE_{args.stage.upper().replace('-', '_')}={status}")
    return 0 if status == "PASS" else 1

if __name__ == "__main__":
    raise SystemExit(main())
