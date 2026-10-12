"""Verify actual RR Core status/latency events from live FastAPI E2E log."""
from __future__ import annotations

import os
import re
from pathlib import Path

PATTERN = re.compile(
    r"RR_HTTP_OPERATION template=(\S+) method=(GET|POST) "
    r"status=(\d{3}) duration_ms=(\d+(?:\.\d+)?)"
)

def main() -> None:
    path = Path(os.environ["RUNNER_TEMP"]) / "qdip-fastapi.log"
    assert path.is_file(), "real FastAPI server log missing"
    lines = [
        line for line in path.read_text(encoding="utf-8", errors="replace").splitlines()
        if "RR_HTTP_OPERATION" in line
    ]
    assert lines, "RR Core emitted no latency events"
    observations = []
    for line in lines:
        found = PATTERN.search(line)
        assert found is not None, "malformed RR status/latency event"
        template, method, status, milliseconds = found.groups()
        assert "{" not in template or "}" in template
        assert "?" not in template, "query parameters must not be logged"
        assert "rr-e2e-org" not in line and "econ-snap-" not in line
        assert float(milliseconds) >= 0
        assert 100 <= int(status) <= 599
        observations.append((template, method, int(status)))
    assert any(
        "source-import/executions" in p and m == "POST" and s == 201
        for p, m, s in observations
    ), "missing successful source import metric"
    assert any(
        "economic-v2/advice" in p and m == "POST" and s == 200
        for p, m, s in observations
    ), "missing successful economic solve metric"
    assert any(
        "economic-v2/advice" in p and m == "GET" and s == 409
        for p, m, s in observations
    ), "missing fail-closed archive-tamper metric"
    assert any(
        "source-import/preflight" in p and m == "POST" and s == 422
        for p, m, s in observations
    ), "invalid normalized import must be recorded as 422 (not 500)"
    assert any(
        "source-import/preflight" in p and m == "POST" and s == 401
        for p, m, s in observations
    ), "invalid API key must be recorded as 401 (not 500)"
    print(f"RR_HTTP_METRICS_E2E=PASS events={len(observations)}")


if __name__ == "__main__":
    main()
