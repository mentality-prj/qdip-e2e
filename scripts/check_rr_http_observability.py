"""Verify actual RR Core status/latency events from live FastAPI E2E log."""
from __future__ import annotations

import os
import re
import json
from collections import defaultdict
from math import ceil
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
    latencies: dict[tuple[str, str], list[float]] = defaultdict(list)
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
        latencies[(template, method)].append(float(milliseconds))
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
    # A deterministic, sanitized real-service aggregation, not a field SLA:
    # fixed-cardinality route templates only; never persist raw URLs/headers.
    groups = {
        f"{template} {method}": {
            "requests": len(measured),
            "p95_duration_ms": sorted(measured)[ceil(.95 * len(measured)) - 1],
        }
        for (template, method), measured in sorted(latencies.items())
    }
    status_classes = {
        label: sum((lo <= status <= hi) for _, _, status in observations)
        for label, lo, hi in (("2xx", 200, 299), ("4xx", 400, 499), ("5xx", 500, 599))
    }
    # A real E2E requests tiny samples. p95 is recorded, not claimed as
    # production latency or pass/fail acceptance threshold.
    sanitized = {
        "schema_version": "rr.http-observability-e2e.v1",
        "scope": "ISOLATED_REAL_SERVICE_ONLY_NOT_PRODUCTION_SLO",
        "request_count": len(observations),
        "status_classes": status_classes,
        "http_error_fraction": round(
            (status_classes["4xx"] + status_classes["5xx"]) / len(observations), 6
        ),
        "by_route": groups,
    }
    output = Path(os.environ["RUNNER_TEMP"]) / "rr-http-metrics-summary.json"
    output.write_text(
        json.dumps(sanitized, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    output.chmod(0o600)
    print(f"RR_HTTP_METRICS_E2E=PASS events={len(observations)} scope=isolated")


if __name__ == "__main__":
    main()
