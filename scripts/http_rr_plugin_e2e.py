"""Real, non-mocked Core/Web RR plugin-contract acceptance against disposable Mongo.

Runs only in the explicitly required rr-plugin-v1 E2E mode, after the ordinary
native-Mongo/CP-SAT HTTP suite. No secrets, customer records or fixture payloads
are emitted in public workflow logs or uploaded artifacts.
"""
from __future__ import annotations

import copy
import hashlib
import hmac
import json
import os
import secrets
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx

BASE = "http://127.0.0.1:8000/api/v1/readiness-recovery"
VERSION = "readiness-recovery.presentation.v1"


def signed_actor(*, operation: str, expires: int, alter_signature: bool = False) -> tuple[str, str]:
    """Synthetic signed BFF hint, NOT a substitute for genuine Zitadel login."""
    issuer, subject = "https://e2e.invalid", "test-subject"
    actor = "zitadel:" + hashlib.sha256((issuer + chr(0) + subject).encode()).hexdigest()
    unsigned = f"v1.{expires}.{actor}.{operation}"
    signature = hmac.new(
        os.environ["RR_ACTOR_ASSERTION_SECRET"].encode(), unsigned.encode(), hashlib.sha256
    ).hexdigest()
    if alter_signature:
        signature = ("0" if signature[0] != "0" else "1") + signature[1:]
    return unsigned + "." + signature, actor



def call(
    client: httpx.Client,
    method: str,
    path: str,
    key: str | None,
    *,
    payload: dict | None = None,
    actor_assertion: str | None = None,
) -> httpx.Response:
    headers = {"x-api-key": key} if key else {}
    if actor_assertion is not None:
        headers["x-qdip-actor-assertion"] = actor_assertion
    return client.request(method, BASE + path, headers=headers, json=payload)


def expected(response: httpx.Response, status: int) -> dict:
    assert response.status_code == status, f"RR plugin contract: expected {status}, got {response.status_code}"
    value = response.json()
    assert isinstance(value, dict)
    return value


def check_projection(value: dict, *, execution_id: str, decision_id: str, snapshot: str) -> None:
    assert value["schema_version"] == VERSION
    assert value["computation_authority"] == "QDIP_KERNEL_RR_V1"
    assert value["execution_id"] == execution_id
    assert value["decision_id"] == decision_id
    assert value["source_snapshot_id"] == snapshot
    assert value["field_verified"] is False
    assert value["probability_demand_satisfied"] is None
    assert value["probability_confidence_interval"] is None
    assert value["authoritative"] is True
    assert value["actionable"] is True
    assert value["backend_status"] == "OPTIMAL"
    assert value["outcome_kind"] == "OPTIMAL_DECISION"
    assert len(value["payload_digest"]) == 64
    assert value["scheduled_job_count"] == len(value["scheduled_jobs"])
    assert value["scheduled_jobs"]
    for item in value["scheduled_jobs"]:
        assert item["job_id"] and item["technician_id"]
        assert isinstance(item["start_slot"], int)
        assert isinstance(item["finish_slot"], int)
        assert item["finish_slot"] > item["start_slot"]


def main() -> None:
    assert os.environ.get("GITHUB_ACTIONS") == "true"
    assert os.environ.get("RR_E2E_CONTRACT_MODE") == "rr-plugin-v1"
    assert "127.0.0.1:27019/qdip_e2e?" in os.environ.get("MONGODB_URL", "")
    key_a, key_b = os.environ["E2E_KEY_A"], os.environ["E2E_KEY_B"]
    base = Path(__file__).resolve().parents[1]
    initial = json.loads((base / "fixtures/rr_reference_api_v1.json").read_text(encoding="utf-8"))
    suffix = secrets.token_hex(7)
    now = datetime.now(UTC)
    execution_id = f"rr-plugin-{suffix}-001"
    successor_id = f"rr-plugin-{suffix}-002"
    decision_id = f"civilian-plugin-{suffix}"
    snapshot_id = f"civilian-snapshot-{suffix}"

    initial["execution_id"] = execution_id
    initial["source"]["snapshot_id"] = snapshot_id
    initial["source"]["captured_at"] = now.isoformat()
    initial["ingested_at"] = now.isoformat()
    initial["payload"]["decision_id"] = decision_id

    with httpx.Client(timeout=65) as client:
        # Denials must be real server responses, not a mocked browser route.
        expected(call(client, "POST", "/preflight", None, payload=initial), 401)
        expected(call(client, "POST", "/preflight", "invalid-api-key", payload=initial), 401)
        expected(call(client, "GET", f"/executions/{execution_id}/presentation", None), 401)

        invalid = copy.deepcopy(initial)
        invalid["payload"]["jobs"] = []
        malformed = call(client, "POST", "/preflight", key_a, payload=invalid)
        assert malformed.status_code in (413, 422), "Invalid RR jobs must fail server preflight"
        assert isinstance(malformed.json(), dict)

        # Server-only preflight does not schedule jobs or persist any execution.
        before = expected(call(client, "GET", f"/executions/{execution_id}", key_a), 404)
        assert isinstance(before, dict)
        preflight = expected(call(client, "POST", "/preflight", key_a, payload=initial), 200)
        assert preflight["schema_version"] == VERSION
        assert preflight["validation_scope"] == "SCHEMA_AND_ADMISSION_ONLY"
        assert preflight["warning"] == "NOT_EXECUTION_OR_FEASIBILITY_PROOF"
        assert preflight["accepted_for_kernel_submission"] is True
        assert preflight["execution_id"] == execution_id
        assert preflight["decision_id"] == decision_id
        assert preflight["source_snapshot_id"] == snapshot_id
        assert preflight["job_count"] == len(initial["payload"]["jobs"])
        assert preflight["technician_count"] == len(initial["payload"]["technicians"])
        expected(call(client, "GET", f"/executions/{execution_id}", key_a), 404)

        created = expected(call(client, "POST", "/executions", key_a, payload=initial), 201)
        assert created["result"]["workflow"]["execution_id"] == execution_id
        assert created["organization_id"] == "rr-e2e-org-a"
        projection = expected(call(client, "GET", f"/executions/{execution_id}/presentation", key_a), 200)
        check_projection(projection, execution_id=execution_id, decision_id=decision_id, snapshot=snapshot_id)
        assert projection["predecessor_execution_id"] is None
        assert projection["change_kind"] == "INITIAL"
        expected(call(client, "GET", f"/executions/{execution_id}/presentation", key_b), 404)

        # Independent HMAC/actor-attribution test on actual Core HTTP and Mongo.
        # The assertion is synthetic but signed exactly as the OIDC BFF signs
        # audit hints; this does NOT claim that a real Zitadel login was tested.
        actor_input = copy.deepcopy(initial)
        actor_input["execution_id"] = f"rr-actor-{suffix}-001"
        actor_input["payload"]["decision_id"] = f"civilian-actor-{suffix}"
        actor_input["source"]["snapshot_id"] = f"actor-snapshot-{suffix}"
        expires = int(time.time()) + 30
        ok_assertion, expected_actor = signed_actor(operation="execute", expires=expires)
        tampered, _ = signed_actor(operation="execute", expires=expires, alter_signature=True)
        invalid_sig = call(
            client, "POST", "/executions", key_a, payload=actor_input, actor_assertion=tampered
        )
        assert invalid_sig.status_code == 403, "Tampered OIDC actor assertion must fail"
        expired, _ = signed_actor(operation="execute", expires=int(time.time()) - 2)
        invalid_expiry = call(
            client, "POST", "/executions", key_a, payload=actor_input, actor_assertion=expired
        )
        assert invalid_expiry.status_code == 403, "Expired actor assertion must fail"
        wrong_operation, _ = signed_actor(operation="replan", expires=int(time.time()) + 30)
        invalid_operation = call(
            client, "POST", "/executions", key_a, payload=actor_input,
            actor_assertion=wrong_operation,
        )
        assert invalid_operation.status_code == 403, "Actor assertion operation must match"
        signed_created = expected(
            call(client, "POST", "/executions", key_a, payload=actor_input, actor_assertion=ok_assertion),
            201,
        )
        assert signed_created["actor_id"] == expected_actor
        # Idempotence must preserve original signed actor attribution.
        retried_signed = expected(
            call(client, "POST", "/executions", key_a, payload=actor_input, actor_assertion=ok_assertion),
            201,
        )
        assert retried_signed["actor_id"] == expected_actor
        assert expected(call(client, "GET", f"/executions/{actor_input['execution_id']}", key_a), 200)[
            "actor_id"
        ] == expected_actor

        actor_later = now + timedelta(seconds=3)
        actor_replan = {
            "execution_id": f"rr-actor-{suffix}-002",
            "change_id": f"actor-change-{suffix}",
            "kind": "OVERRIDE",
            "reason": "Exclude invented sensor-service after synthetic signed attribution.",
            "requested_at": actor_later.isoformat(),
            "source": actor_input["source"],
            "ingested_at": actor_later.isoformat(),
            "payload": {
                **actor_input["payload"],
                "operator_directives": {"excluded_job_ids": ["sensor-service"]},
            },
        }
        bad_replan = call(
            client, "POST", f"/executions/{actor_input['execution_id']}/replan",
            key_a, payload=actor_replan, actor_assertion=ok_assertion,
        )
        assert bad_replan.status_code == 403, "Execute-only signature cannot authorize replan"
        replan_assertion, _ = signed_actor(operation="replan", expires=int(time.time()) + 30)
        actor_revision = expected(
            call(
                client, "POST", f"/executions/{actor_input['execution_id']}/replan",
                key_a, payload=actor_replan, actor_assertion=replan_assertion,
            ),
            201,
        )
        assert actor_revision["actor_id"] == expected_actor
        assert actor_revision["result"]["workflow"]["change"]["predecessor_execution_id"] == actor_input[
            "execution_id"
        ]
        assert expected(
            call(client, "GET", f"/executions/{actor_replan['execution_id']}", key_a), 200
        )["actor_id"] == expected_actor

        # New persisted revision and plugin-computed evidence, never inferred by UI.
        later = now + timedelta(seconds=2)
        revision = {
            "execution_id": successor_id,
            "change_id": f"civilian-change-{suffix}",
            "kind": "OVERRIDE",
            "reason": "Exclude the invented sensor-service job during civilian test.",
            "requested_at": later.isoformat(),
            "source": initial["source"],
            "ingested_at": later.isoformat(),
            "payload": {
                **initial["payload"],
                "operator_directives": {"excluded_job_ids": ["sensor-service"]},
            },
        }
        updated = expected(
            call(client, "POST", f"/executions/{execution_id}/replan", key_a, payload=revision), 201
        )
        assert updated["result"]["workflow"]["execution_id"] == successor_id
        fresh = expected(call(client, "GET", f"/executions/{successor_id}/presentation", key_a), 200)
        check_projection(fresh, execution_id=successor_id, decision_id=decision_id, snapshot=snapshot_id)
        assert fresh["predecessor_execution_id"] == execution_id
        assert fresh["change_kind"] == "OVERRIDE"
        assert not any(job["job_id"] == "sensor-service" for job in fresh["scheduled_jobs"])

        history = expected(call(client, "GET", f"/decisions/{decision_id}/history", key_a), 200)
        assert len(history["executions"]) == 2
        integrity = expected(call(client, "GET", f"/decisions/{decision_id}/history-integrity", key_a), 200)
        assert integrity["complete_chain"] is True
        replay = expected(call(client, "GET", f"/executions/{successor_id}/replay-verification", key_a), 200)
        assert replay["verified"] is True

        # This is the actual endpoint consumed by the staged Web operator.
        # Core attests each page; the browser must not invent history integrity.
        page_path = f"/decisions/{decision_id}/history/verified-export-page"
        first_page = expected(call(client, "GET", page_path, key_a), 200)
        assert first_page["schema_version"] == VERSION
        assert first_page["history_verified"] is True
        assert first_page["export_complete"] is True
        assert first_page["next_cursor"] is None
        assert first_page["head_execution_id"] == successor_id
        assert len(first_page["executions"]) == 2
        assert len(first_page["history_manifest_digest"]) == 64
        second_head = expected(
            call(client, "GET", page_path + f"?expected_head={successor_id}", key_a), 200
        )
        assert second_head["history_manifest_digest"] == first_page["history_manifest_digest"]
        changed_head = call(client, "GET", page_path + "?expected_head=not-the-head", key_a)
        assert changed_head.status_code == 409, "Core must reject a stale verified export head"
        missing_cursor = call(client, "GET", page_path + "?cursor=not-an-execution", key_a)
        assert missing_cursor.status_code in (409, 422), "Invalid verified export cursor must fail"
        assert call(client, "GET", page_path, key_b).status_code in (403, 404, 409)

        exported = expected(call(client, "GET", f"/decisions/{decision_id}/history/export-complete", key_a), 200)
        assert exported["schema_version"] == VERSION
        assert exported["decision_id"] == decision_id
        assert exported["head_execution_id"] == successor_id
        assert exported["history_verified"] is True
        assert exported["export_complete"] is True
        assert len(exported["executions"]) == 2
        expected(call(client, "GET", f"/decisions/{decision_id}/history/export-complete", key_b), 409)

    (base / "reports" / "rr-plugin-contract-summary.json").write_text(
        json.dumps(
            {
                "schema": "qdip.e2e.rr-plugin-v1",
                "real_http": True,
                "real_mongo": True,
                "preflight_no_persistence": "PASS",
                "negative_schema_auth_tenant": "PASS",
                "persisted_kernel_presentation": "PASS",
                "replan_history_replay_verified_export": "PASS",
                "verified_export_page_head_manifest_negative": "PASS",
                "signed_actor_tamper_expiry_operation_and_audit": "PASS",
                "stochastic_roi_or_field_verification": "NOT_CLAIMED",
                "oidc": "NOT_TESTED",
            },
            indent=2,
        ) + "\n",
        encoding="utf-8",
    )
    print("RR_PLUGIN_REAL_HTTP_E2E=PASS")


if __name__ == "__main__":
    main()
