"""End-to-end acceptance for new RR HTTP routes against real Core + Mongo.

Only synthetic civilian fixtures; no monkeypatch, no in-process API, no production
data. Requires the disposable native E2E runner's two org-scoped keys.
"""
from __future__ import annotations

import copy
import json
import os
import secrets
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx

BASE = "http://127.0.0.1:8000/api/v1/readiness-recovery"


def check(response: httpx.Response, code: int) -> dict:
    assert response.status_code == code, (
        f"RR live E2E: HTTP {response.status_code}, expected {code} on "
        f"{response.request.method} {response.request.url.path}"
    )
    value = response.json()
    assert isinstance(value, dict)
    return value


def send(
    client: httpx.Client, method: str, endpoint: str, key: str,
    payload: dict | None = None,
) -> httpx.Response:
    return client.request(
        method, BASE + endpoint, headers={"x-api-key": key},
        json=payload,
    )


def main() -> None:
    assert os.environ.get("GITHUB_ACTIONS") == "true"
    assert "127.0.0.1:27019/qdip_e2e?" in os.environ.get("MONGODB_URL", "")
    key_a, key_b = os.environ["E2E_KEY_A"], os.environ["E2E_KEY_B"]
    fixture = json.loads(
        (Path(__file__).resolve().parents[1] / "fixtures/rr_reference_api_v1.json")
        .read_text(encoding="utf-8")
    )
    suffix = secrets.token_hex(6)
    now = datetime.now(UTC)
    fixture["execution_id"] = f"rr-import-{suffix}-1"
    fixture["payload"]["decision_id"] = f"rr-import-{suffix}"
    fixture["source"]["snapshot_id"] = f"rr-source-{suffix}"
    fixture["source"]["captured_at"] = (now - timedelta(seconds=12)).isoformat()
    fixture["ingested_at"] = (now - timedelta(seconds=10)).isoformat()

    with httpx.Client(timeout=65) as client:
        # Canonical Core preflight obtains the digest of this independently
        # authored JSON fixture; the importer must prove that digest binding.
        initial = check(send(client, "POST", "/preflight", key_a, fixture), 200)
        imported = {
            "format_version": "readiness-recovery.normalized-import.v1",
            **fixture,
            "payload_digest": initial["payload_digest"],
        }
        endpoint = "/source-import/preflight"
        check(send(client, "POST", endpoint, key_a, imported), 200)
        assert send(client, "POST", endpoint, key_b, imported).status_code == 503
        assert send(client, "POST", endpoint, "invalid-key", imported).status_code == 401
        with_bad_digest = {**imported, "payload_digest": "0" * 64}
        assert send(client, "POST", endpoint, key_a, with_bad_digest).status_code == 422
        with_bad_source = copy.deepcopy(imported)
        with_bad_source["source"]["source_system"] = "unapproved-source"
        assert send(client, "POST", endpoint, key_a, with_bad_source).status_code == 422
        check(
            send(client, "GET", f"/executions/{fixture['execution_id']}", key_a),
            404,
        )
        created = check(
            send(client, "POST", "/source-import/executions", key_a, imported),
            201,
        )
        assert created["result"]["workflow"]["execution_id"] == fixture["execution_id"]
        again = check(
            send(client, "POST", "/source-import/executions", key_a, imported),
            201,
        )
        assert again["result"]["workflow"]["execution_id"] == fixture["execution_id"]
        check(
            send(client, "GET", f"/executions/{fixture['execution_id']}", key_b),
            404,
        )
        verify = check(
            send(
                client, "GET",
                f"/executions/{fixture['execution_id']}/replay-verification",
                key_a,
            ),
            200,
        )
        assert verify["verified"] is True

        revised = copy.deepcopy(fixture)
        revised["execution_id"] = f"rr-import-{suffix}-2"
        revised["ingested_at"] = (now - timedelta(seconds=3)).isoformat()
        revised["payload"]["operator_directives"] = {
            "excluded_job_ids": ["sensor-service"],
        }
        before_change = check(send(client, "POST", "/preflight", key_a, revised), 200)
        imported_revision = {
            "format_version": "readiness-recovery.normalized-import.v1",
            **revised,
            "payload_digest": before_change["payload_digest"],
        }
        replan = {
            "format_version": "readiness-recovery.normalized-replan.v1",
            "change_id": f"rr-change-{suffix}",
            "kind": "OVERRIDE",
            "reason": "Synthetic operator override for real E2E acceptance.",
            "requested_at": (now - timedelta(seconds=1)).isoformat(),
            "import_document": imported_revision,
        }
        replan_path = (
            f"/source-import/executions/{fixture['execution_id']}/replan"
        )
        updated = check(send(client, "POST", replan_path, key_a, replan), 201)
        assert updated["result"]["workflow"]["execution_id"] == revised["execution_id"]
        assert send(client, "POST", replan_path, key_a, replan).status_code == 201
        history = check(send(
            client, "GET", f"/decisions/{fixture['payload']['decision_id']}/history",
            key_a,
        ), 200)
        assert len(history["executions"]) == 2
        assert send(client, "POST", replan_path, key_b, replan).status_code in (403, 503, 404)

        # Full native CP-SAT solving via Kernel v1; modeled only, never
        # physical procurement/stock reservation.
        snap = f"econ-snap-{suffix}"
        economic = {
            "schema_version": "readiness-recovery.economic-state.v2",
            "snapshot_id": snap,
            "operational": {
                "decision_id": f"econ-choice-{suffix}",
                "horizon_slots": 3,
                "workshop_capacity": 1,
                "technicians": [{
                    "id": "tech", "skills": ["repair"], "available_slots": [0, 1, 2]
                }],
                "jobs": [{
                    "id": "repair", "duration_slots": 1,
                    "required_skills": ["repair"], "deadline_slot": 3,
                    "readiness_gain_units": 0,
                }],
            },
            "assets": [{"id": "machine", "state_revision": 1, "initially_ready": False}],
            "restorations": [{"job_id": "repair", "asset_id": "machine"}],
            "occupations": [{"job_id": "repair", "asset_ids": ["machine"]}],
            "job_costs": [{"job_id": "repair", "all_in_cost_cents": 100}],
            "capabilities": [{
                "id": "output", "asset_ids": ["machine"],
                "contribution_cents_by_slot": [0, 200, 200],
            }],
        }
        registered = check(send(
            client, "POST", "/economic-v2/snapshots", key_a, economic
        ), 201)
        assert registered["snapshot_id"] == snap
        assert registered["actionable"] is False
        check(send(client, "POST", "/economic-v2/snapshots", key_a, economic), 201)
        changed = copy.deepcopy(economic)
        changed["capabilities"][0]["contribution_cents_by_slot"] = [0, 250, 250]
        assert send(client, "POST", "/economic-v2/snapshots", key_a, changed).status_code == 409
        run = {"snapshot_id": snap, "execution_id": f"econ-advice-{suffix}"}
        solved = check(send(client, "POST", "/economic-v2/advice", key_a, run), 200)
        assert solved["status"] == "OPTIMAL"
        assert solved["actionable"] is False
        assert solved["atomic_plan_committed"] is False
        assert solved["supply_source_verified"] is False
        assert solved["snapshot_digest"] == registered["input_digest"]
        assert len(solved["scheduled_jobs"]) == 1
        assert str(solved["modeled_net_incremental_cents"]) == "300"
        assert solved["manifest"]["execution_id"] == run["execution_id"]
        check(
            send(client, "GET", f"/economic-v2/advice/{run['execution_id']}", key_b),
            404,
        )
        archived = check(
            send(client, "GET", f"/economic-v2/advice/{run['execution_id']}", key_a),
            200,
        )
        assert archived == solved
        integrity = check(
            send(
                client, "GET",
                f"/economic-v2/advice/{run['execution_id']}/integrity",
                key_a,
            ),
            200,
        )
        assert integrity["archive_digest_verified"] is True
        assert integrity["snapshot_binding_verified"] is True
        assert integrity["kernel_manifest_verified"] is True
        assert integrity["actionable"] is False
        assert integrity["snapshot_digest"] == registered["input_digest"]
        assert send(
            client, "GET",
            f"/economic-v2/advice/{run['execution_id']}/integrity",
            key_b,
        ).status_code == 404
        listing = check(send(client, "GET", "/economic-v2/advice?limit=10", key_a), 200)
        assert listing["schema_version"] == "readiness-recovery.economic-advice-list.v2"
        assert any(
            row["execution_id"] == run["execution_id"]
            for row in listing["entries"]
        )
        other_listing = check(
            send(client, "GET", "/economic-v2/advice?limit=10", key_b), 200
        )
        assert other_listing["entries"] == []
        assert check(
            send(client, "POST", "/economic-v2/advice", key_a, run), 200
        ) == archived
        assert send(
            client, "POST", "/economic-v2/advice", key_b, run
        ).status_code == 404

    print("RR_COMPLETE_HTTP_E2E=PASS")
    print("RR_REAL_ZITADEL_EXTERNAL=NOT_TESTED")
    print("RR_ECONOMIC_EXTERNAL_ACTIONS=NOT_IMPLEMENTED")


if __name__ == "__main__":
    main()
