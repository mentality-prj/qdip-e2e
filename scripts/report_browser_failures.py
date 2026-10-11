"""Public-safe diagnosis for the isolated Playwright E2E runner.

Print only predetermined public test names, status classes, numeric HTTP
expectations, and source-line positions. Never echo raw browser logs, page
content, backend payloads, credentials, or private source.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

REQUIRED = [
    "public RR is a read-only civilian input example",
    "anonymous browser cannot preflight",
    "Studio-only Zitadel subject cannot access RR operator",
    "tampered isolated OIDC session never authorizes",
    "live browser → Core preflight",
    "invalid input fails closed in real Core preflight",
]

def specs(suites: list[dict]) -> list[dict]:
    items = []
    for suite in suites:
        items += suite.get("specs", [])
        items += specs(suite.get("suites", []))
    return items

def main() -> None:
    raw = Path(os.environ.get("RUNNER_TEMP", "")) / "qdip-browser-report.json"
    if os.environ.get("GITHUB_ACTIONS") != "true" or not raw.exists():
        print("BROWSER_DIAGNOSTIC=NO_JSON_REPORT")
        return
    try:
        report = json.loads(raw.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        print("BROWSER_DIAGNOSTIC=INVALID_JSON_REPORT")
        return
    all_cases = specs(report.get("suites", []))
    print("BROWSER_DIAGNOSTIC_SPEC_COUNT=" + str(len(all_cases)))
    for idx, name in enumerate(REQUIRED):
        matched = [s for s in all_cases if str(s.get("title", "")).startswith(name)]
        if len(matched) != 1:
            print(f"BROWSER_CASE_{idx+1}=MISSING_OR_DUPLICATE")
            continue
        spec = matched[0]
        annotations = [*spec.get("annotations", [])]
        for case in spec.get("tests", []):
            annotations.extend(case.get("annotations", []))
        for annotation in annotations:
            label, value = annotation.get("type", ""), annotation.get("description", "")
            if re.fullmatch(r"rr-[a-z-]{1,45}", label) and re.fullmatch(r"(?:[1-5][0-9]{2}|true|false)", value):
                print(f"BROWSER_CASE_{idx+1}_{label.replace('-', '_').upper()}={value}")
        print(f"BROWSER_CASE_{idx+1}=" + ("PASS" if spec.get("ok") else "FAIL"))
        if spec.get("ok"):
            continue
        errors = [
            r.get("error", {}).get("message", "")
            for test in spec.get("tests", [])
            for r in test.get("results", [])
            if isinstance(r.get("error"), dict)
        ]
        combined = " ".join(errors)
        kinds = [
            ("AUTH", r"(401|403|unauthorized|forbidden)"),
            ("MISSING_ELEMENT", r"(not found|received: hidden|locator|not attached)"),
            ("HTTP_STATUS", r"(status|Response|Received:|Expected:)"),
            ("TIMEOUT", r"(timeout|exceeded)"),
            ("SESSION_CONFIG", r"(Isolated OIDC-session test configuration|QDIP_AUTH|not configured)"),
            ("ASSERTION", r"(AssertionError|expect\()"),
        ]
        categories = [key for key, pattern in kinds if re.search(pattern, combined, re.IGNORECASE)]
        print(f"BROWSER_CASE_{idx+1}_ERROR_CATEGORIES=" + (",".join(categories) or "UNKNOWN"))
        num_match = re.search(r"Expected:\s*(\d{3})[\s\S]{0,160}?Received:\s*(\d{3})", combined)
        if num_match:
            print(f"BROWSER_CASE_{idx+1}_EXPECTED_HTTP={num_match.group(1)}")
            print(f"BROWSER_CASE_{idx+1}_RECEIVED_HTTP={num_match.group(2)}")
        locations = sorted(set(re.findall(r"rr_oidc_session_real_e2e\.spec\.ts:(\d+)", combined)))
        if locations:
            print(f"BROWSER_CASE_{idx+1}_PUBLIC_SPEC_LINES=" + ",".join(locations[:4]))
    stats = report.get("stats", {})
    print("BROWSER_REPORTED_UNEXPECTED=" + str(stats.get("unexpected", "unknown")))
    print("BROWSER_REPORTED_SKIPPED=" + str(stats.get("skipped", "unknown")))

if __name__ == "__main__":
    main()
