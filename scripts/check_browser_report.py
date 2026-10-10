"""Fail closed when an essential Playwright browser test is absent or skipped."""
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

def main() -> int:
    path = Path(os.environ["RUNNER_TEMP"]) / "qdip-browser-report.json"
    report = json.loads(path.read_text(encoding="utf-8"))
    specs = cases(report.get("suites", []))
    expected = (
        "production RR requires a logged-in operator",
        "public RR demo does not expose a prior scenario",
        "reference operator: Kernel execution, reasoned replan",
    )
    titles = [s.get("title", "") for s in specs]
    stats = report.get("stats", {})
    if (len(specs) != 3 or any(not any(x.startswith(prefix) for x in titles) for prefix in expected)
            or stats.get("skipped", 0) != 0 or stats.get("unexpected", 0) != 0
            or stats.get("expected", 0) != 3):
        print("BROWSER_REQUIRED_TEST_MATRIX=FAIL")
        return 1
    print("BROWSER_REQUIRED_TEST_MATRIX=PASS (3/3, 0 skipped)")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
