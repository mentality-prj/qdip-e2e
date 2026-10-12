"""Real FastAPI + Mongo E2E of missing and rotated RR archive MAC keys."""
from __future__ import annotations
import json
import os
import secrets
import subprocess
import sys
import time
from pathlib import Path
import httpx

def probe(kind: str, url_path: str, expected: int) -> None:
    backend = Path(__file__).resolve().parents[2] / "backend"
    assert backend.is_dir()
    env = os.environ.copy()
    if kind == "missing":
        env.pop("RR_ECONOMIC_EVIDENCE_HMAC_KEY", None)
    else:
        env["RR_ECONOMIC_EVIDENCE_HMAC_KEY"] = secrets.token_hex(32)
        assert env["RR_ECONOMIC_EVIDENCE_HMAC_KEY"] != os.environ["RR_ECONOMIC_EVIDENCE_HMAC_KEY"]
    filename = Path(os.environ["RUNNER_TEMP"]) / f"rr-economic-key-{kind}.log"
    with filename.open("wb") as logfile:
        process = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8011", "--no-access-log"],
            cwd=backend, env=env, stdout=logfile, stderr=subprocess.STDOUT,
        )
        try:
            with httpx.Client(timeout=5) as client:
                for _ in range(100):
                    assert process.poll() is None, "isolated FastAPI process stopped"
                    try:
                        if client.get("http://127.0.0.1:8011/health").status_code == 200:
                            break
                    except httpx.TransportError:
                        pass
                    time.sleep(.1)
                else:
                    raise AssertionError("isolated FastAPI did not start")
                result = client.get(
                    "http://127.0.0.1:8011/api/v1/readiness-recovery/" + url_path,
                    headers={"x-api-key": os.environ["E2E_KEY_A"]},
                )
                assert result.status_code == expected, f"{kind}: expected {expected}, got {result.status_code}"
        finally:
            process.terminate()
            try:
                process.wait(timeout=12)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)

def main() -> None:
    assert os.environ["GITHUB_ACTIONS"] == "true"
    assert os.environ["RR_E2E_ONLY"] == "1"
    assert os.environ["MONGODB_URL"] == "mongodb://127.0.0.1:27019/qdip_e2e?replicaSet=rrtest&directConnection=true"
    state = json.loads((Path(os.environ["RUNNER_TEMP"]) / "qdip-rr-functional-state.json").read_text())
    assert state["economic_execution_id"].startswith("econ-advice-")
    path = "economic-v2/advice/" + state["economic_execution_id"]
    probe("missing", path, 503)
    probe("rotated", path, 409)
    print("RR_ECONOMIC_EVIDENCE_KEY_E2E=PASS (missing 503; wrong-key 409)")

if __name__ == "__main__":
    main()
