"""Actual network HTTP → FastAPI → native Mongo replica → frozen CP-SAT Kernel."""
from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
import os
import secrets
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx

ROOT = "http://127.0.0.1:8000/api/v1/readiness-recovery"


def request(client: httpx.Client, method: str, path: str, key: str | None, **kwargs: object) -> httpx.Response:
    headers = {"x-api-key": key} if key else {}
    response = client.request(method, ROOT + path, headers=headers, **kwargs)
    if response.status_code >= 500:
        raise AssertionError(f"Server returned {response.status_code} on {method} {path}")
    return response


def expect_status(resp: httpx.Response, status: int) -> dict:
    if resp.status_code != status:
        raise AssertionError(f"Expected HTTP {status}, got {resp.status_code}")
    return resp.json()


def main() -> None:
    assert os.environ.get("GITHUB_ACTIONS") == "true"
    org_a, org_b = os.environ["E2E_KEY_A"], os.environ["E2E_KEY_B"]
    fixture_path = Path(os.environ["RR_E2E_API_REQUEST_PATH"])
    run_id = secrets.token_hex(7)
    now = datetime.now(UTC)
    initial = json.loads((Path(__file__).resolve().parents[1] / "fixtures" / "rr_reference_api_v1.json").read_text(encoding="utf-8"))
    original_id = f"rr-e2e-{run_id}-01"
    revised_id = f"rr-e2e-{run_id}-02"
    decision_id = f"civilian-e2e-{run_id}"
    initial["execution_id"] = original_id
    initial["source"]["snapshot_id"] = f"e2e-snapshot-{run_id}"
    initial["source"]["captured_at"] = now.isoformat()
    initial["ingested_at"] = now.isoformat()
    initial["payload"]["decision_id"] = decision_id
    # Browser test uses its own unique ID.
    fixture_path.write_text(json.dumps(initial, indent=2), encoding="utf-8")
    fixture_path.chmod(0o600)

    with httpx.Client(timeout=50) as client:
        expect_status(request(client, "GET", "/executions/unknown", None), 401)
        expect_status(request(client, "GET", "/executions/unknown", "bad-key"), 401)
        rec = expect_status(request(client, "POST", "/executions", org_a, json=initial), 201)
        assert rec["organization_id"] == "rr-e2e-org-a"
        assert rec["result"]["workflow"]["execution_id"] == original_id
        assert rec["result"]["runtime"]["execution_result"]["backend_status"] == "OPTIMAL"
        assert rec["result"]["runtime"]["execution_result"]["semantic_status"] == "EXACT"
        expect_status(request(client, "GET", f"/executions/{original_id}", org_b), 404)
        expect_status(request(client, "GET", f"/executions/{original_id}", org_a), 200)
        retry = expect_status(request(client, "POST", "/executions", org_a, json=initial), 201)
        assert retry["result"]["workflow"]["execution_id"] == original_id

        later = now + timedelta(seconds=2)
        change = {
            "execution_id": revised_id,
            "change_id": f"e2e-change-{run_id}",
            "kind": "OVERRIDE",
            "reason": "Exclude invented sensor service for this isolated verification.",
            "requested_at": later.isoformat(),
            "source": initial["source"],
            "ingested_at": later.isoformat(),
            "payload": {**initial["payload"], "operator_directives": {"excluded_job_ids": ["sensor-service"]}},
        }
        replan = expect_status(request(client, "POST", f"/executions/{original_id}/replan", org_a, json=change), 201)
        assert replan["result"]["workflow"]["change"]["predecessor_execution_id"] == original_id
        hist = expect_status(request(client, "GET", f"/decisions/{decision_id}/history", org_a), 200)
        assert len(hist["executions"]) == 2
        integrity = expect_status(request(client, "GET", f"/decisions/{decision_id}/history-integrity", org_a), 200)
        assert integrity["complete_chain"] is True
        replay = expect_status(request(client, "GET", f"/executions/{revised_id}/replay-verification", org_a), 200)
        assert replay["verified"] is True
        exported = expect_status(request(client, "GET", f"/decisions/{decision_id}/history/export", org_a), 200)
        assert exported["export_complete"] is True
        assert len(exported["executions"]) == 2
        assert exported["head_execution_id"] == revised_id
        other_hist = expect_status(request(client, "GET", f"/decisions/{decision_id}/history", org_b), 200)
        assert other_hist["executions"] == []
        # Separate real-Mongo CAS race: exactly one concurrent successor may commit.
        race_initial = json.loads(json.dumps(initial))
        race_initial["execution_id"] = f"rr-e2e-{run_id}-race-base"
        race_initial["payload"]["decision_id"] = f"civilian-race-{run_id}"
        race_initial["source"]["snapshot_id"] = f"race-snapshot-{run_id}"
        expect_status(request(client, "POST", "/executions", org_a, json=race_initial), 201)

        def competing(index: int) -> int:
            changed = {
                "execution_id": f"rr-e2e-{run_id}-race-{index}",
                "change_id": f"race-change-{run_id}-{index}",
                "kind": "OVERRIDE",
                "reason": "Concurrent synthetic modification: test real head CAS.",
                "requested_at": (now + timedelta(seconds=5)).isoformat(),
                "source": race_initial["source"],
                "ingested_at": (now + timedelta(seconds=5)).isoformat(),
                "payload": {**race_initial["payload"],
                            "operator_directives": {"excluded_job_ids": ["sensor-service"]}},
            }
            with httpx.Client(timeout=60) as parallel_client:
                return request(parallel_client, "POST",
                               f"/executions/{race_initial['execution_id']}/replan",
                               org_a, json=changed).status_code

        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = sorted(pool.map(competing, (1, 2)))
        assert outcomes == [201, 409], "Concurrent replans did not enforce one decision head"
        raced = expect_status(request(client, "GET",
                            f"/decisions/{race_initial['payload']['decision_id']}/history",
                            org_a), 200)
        assert len(raced["executions"]) == 2
        state_path = Path(os.environ["RUNNER_TEMP"]) / "qdip-rr-e2e-state.json"
        state_path.write_text(json.dumps({"original_id": original_id, "revised_id": revised_id, "decision_id": decision_id}), encoding="utf-8")

    evidence = {
        "version": "qdip.e2e.http-rr.v1",
        "real_http_server": True,
        "real_mongo_replica_transactions": True,
        "kernel_authoritative_result": "OPTIMAL/EXACT",
        "create_replan_history_integrity_export_replay": "PASS",
        "retry_idempotence": "PASS",
        "real_concurrent_replan_head_cas": "PASS",
        "negative_auth_cross_tenant": "PASS",
        "oidc": "NOT_TESTED",
        "public_security_sla": "NOT_QUALIFIED",
    }
    p = Path("../suite/reports/http-e2e-summary.json")
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    print("RR_REAL_HTTP_E2E=PASS")


if __name__ == "__main__":
    main()
