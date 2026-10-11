"""Minimal sanitized Playwright failures; never print browser tracebacks or payloads."""
from __future__ import annotations

import json
import os
import re
from pathlib import Path


def specifications(suites: list[dict]) -> list[dict]:
    out: list[dict] = []
    for suite in suites:
        out.extend(suite.get("specs", []))
        out.extend(specifications(suite.get("suites", [])))
    return out


def main() -> None:
    if os.getenv("GITHUB_ACTIONS") != "true":
        raise RuntimeError("CI runner required")
    path = Path(os.environ["RUNNER_TEMP"]) / "qdip-browser-e2e.log"
    if not path.is_file():
        print("RR_BROWSER_DIAG=NO_LOG")
        return
    raw = path.read_text(encoding="utf-8", errors="replace")
    decoder = json.JSONDecoder()
    report = None
    for match in re.finditer(r"(?m)^\{", raw):
        try:
            value, _ = decoder.raw_decode(raw[match.start():])
        except (ValueError, RecursionError):
            continue
        if isinstance(value, dict) and isinstance(value.get("suites"), list):
            report = value
            break
    if report is None:
        print("RR_BROWSER_DIAG=NO_VALID_JSON_REPORT")
        print("RR_BROWSER_CONNECTION_ERROR=" + str(
            "ECONNREFUSED" in raw or "ERR_CONNECTION_REFUSED" in raw
        ))
        return
    specs = specifications(report.get("suites", []))
    print("RR_BROWSER_TOTAL_CASES=" + str(len(specs)))
    for spec in specs:
        states = [
            result.get("status", "unknown")
            for test in spec.get("tests", [])
            for result in test.get("results", [])
        ]
        if not states or any(status != "passed" for status in states):
            title = str(spec.get("title", ""))[:110]
            # These are names from the public, independent E2E test suite.
            title = re.sub(r"[^a-zA-Z0-9_ \-]", "_", title)
            print("RR_BROWSER_TEST_NOT_PASS=" + title)
            print("RR_BROWSER_STATES=" + ",".join(states[:10]))
            for item in spec.get("tests", []):
                for result in item.get("results", []):
                    for error in result.get("errors", []):
                        message = str(error.get("message", ""))
                        first_line = message.splitlines()[0] if message else "EMPTY"
                        first_line = re.sub(
                            r"[^A-Za-z0-9 ():._/-]", "_", first_line
                        )[:140]
                        print("RR_BROWSER_FAILURE_FIRST_LINE=" + first_line)
                        expected = re.search(r"Expected:\s*(\d{3})", message)
                        received = re.search(r"Received:\s*(\d{3})", message)
                        if expected or received:
                            print("RR_BROWSER_EXPECTED_HTTP=" + (
                                expected.group(1) if expected else "unknown"
                            ))
                            print("RR_BROWSER_RECEIVED_HTTP=" + (
                                received.group(1) if received else "unknown"
                            ))
                        elif "Timeout" in message or "timeout" in message:
                            print("RR_BROWSER_FAILURE_KIND=TIMEOUT")
                        elif "toBeVisible" in message:
                            print("RR_BROWSER_FAILURE_KIND=VISIBILITY")
                        else:
                            print("RR_BROWSER_FAILURE_KIND=OTHER")
                        break
    print("RR_BROWSER_UNEXPECTED=" + str(report.get("stats", {}).get("unexpected", "unknown")))
    print("RR_BROWSER_SKIPPED=" + str(report.get("stats", {}).get("skipped", "unknown")))


if __name__ == "__main__":
    main()
