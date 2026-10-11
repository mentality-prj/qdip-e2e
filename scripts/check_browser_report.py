"""Fail closed if any required real-service Chromium test is absent or skipped."""
from __future__ import annotations

import json
import os
from pathlib import Path


def cases(suites: list[dict]) -> list[dict]:
    out: list[dict] = []
    for suite in suites:
        out += suite.get("specs", [])
        out += cases(suite.get("suites", []))
    return out


MATRIX: dict[str, tuple[str, ...]] = {
    "legacy": (
        "production RR requires a logged-in operator",
        "public RR demo does not expose a prior scenario",
        "reference operator: Kernel execution, reasoned replan",
    ),
    "rr-oidc-session-v1": (
        "public RR is a read-only civilian input example",
        "anonymous browser cannot preflight",
        "Studio-only Zitadel subject cannot access RR operator",
        "tampered isolated OIDC session never authorizes",
        "live browser → Core preflight",
        "invalid input fails closed in real Core preflight",
    ),
    "rr-plugin-v1": (
        "public RR is a read-only civilian input example",
        "anonymous browser cannot preflight",
        "live browser → Core preflight",
        "invalid input fails closed in real Core preflight",
    ),
}


def validate(report: dict, mode: str) -> bool:
    required = MATRIX.get(mode)
    if required is None:
        return False
    specs = cases(report.get("suites", []))
    titles = [spec.get("title", "") for spec in specs]
    stats = report.get("stats", {})
    return (
        len(specs) == len(required)
        and all(sum(title.startswith(prefix) for title in titles) == 1 for prefix in required)
        and stats.get("skipped", 0) == 0
        and stats.get("unexpected", 0) == 0
        and stats.get("expected", 0) == len(required)
        and all(spec.get("ok") is True for spec in specs)
    )


def main() -> int:
    mode = os.environ.get("RR_E2E_CONTRACT_MODE", "legacy")
    path = Path(os.environ["RUNNER_TEMP"]) / "qdip-browser-report.json"
    report = json.loads(path.read_text(encoding="utf-8"))
    if not validate(report, mode):
        print("BROWSER_REQUIRED_TEST_MATRIX=FAIL")
        return 1
    print(f"BROWSER_REQUIRED_TEST_MATRIX=PASS ({mode}, {len(MATRIX[mode])} required, zero skipped)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
