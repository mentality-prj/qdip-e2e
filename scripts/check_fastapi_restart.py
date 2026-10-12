"""Observe durable RR state through a NEW real HTTP server process."""
from __future__ import annotations
import json
import os
from pathlib import Path
import httpx

def main() -> None:
    state_file = Path(os.environ["RUNNER_TEMP"]) / "qdip-rr-e2e-state.json"
    state = json.loads(state_file.read_text(encoding="utf-8"))
    headers = {"x-api-key": os.environ["E2E_KEY_A"]}
    base = "http://127.0.0.1:8000/api/v1/readiness-recovery"
    with httpx.Client(timeout=25) as client:
        hist = client.get(f"{base}/decisions/{state['decision_id']}/history", headers=headers)
        assert hist.status_code == 200
        ids = {x["result"]["workflow"]["execution_id"] for x in hist.json()["executions"]}
        assert ids == {state["original_id"], state["revised_id"]}
        repl = client.get(f"{base}/executions/{state['revised_id']}/replay-verification", headers=headers)
        assert repl.status_code == 200 and repl.json()["verified"] is True
        integrity = client.get(f"{base}/decisions/{state['decision_id']}/history-integrity", headers=headers)
        assert integrity.status_code == 200 and integrity.json()["complete_chain"] is True
        forbidden = client.get(f"{base}/executions/{state['original_id']}", headers={"x-api-key":os.environ["E2E_KEY_B"]})
        assert forbidden.status_code == 404
        if os.environ.get("RR_E2E_ONLY") == "1":
            functional_path = (
                Path(os.environ["RUNNER_TEMP"]) / "qdip-rr-functional-state.json"
            )
            # No skipped coverage if the functional suite did not produce
            # exactly the anticipated source checkpoint.
            assert functional_path.is_file()
            bound = json.loads(functional_path.read_text(encoding="utf-8"))
            functional_history = client.get(
                f"{base}/decisions/{bound['decision_id']}/history",
                headers=headers,
            )
            assert functional_history.status_code == 200
            assert {
                row["result"]["workflow"]["execution_id"]
                for row in functional_history.json()["executions"]
            } == {
                bound["import_execution_id"], bound["replan_execution_id"]
            }
            econ_id = bound["economic_execution_id"]
            advice = client.get(
                f"{base}/economic-v2/advice/{econ_id}",
                headers=headers,
            )
            assert advice.status_code == 200
            assert advice.json()["snapshot_digest"] == bound["economic_digest"]
            assert advice.json()["snapshot_id"] == bound["economic_snapshot_id"]
            proof = client.get(
                f"{base}/economic-v2/advice/{econ_id}/integrity",
                headers=headers,
            )
            assert proof.status_code == 200
            verified = proof.json()
            assert verified["archive_digest_verified"] is True
            assert verified["snapshot_binding_verified"] is True
            assert verified["kernel_manifest_verified"] is True
            denied = client.get(
                f"{base}/economic-v2/advice/{econ_id}",
                headers={"x-api-key": os.environ["E2E_KEY_B"]},
            )
            assert denied.status_code == 404
    print("RR_HTTP_DURABLE_RESTART=PASS")

if __name__ == "__main__":
    main()
