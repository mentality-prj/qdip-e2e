"""Real Mongo key revocation must reject the next live FastAPI request."""
from __future__ import annotations

import os
from datetime import UTC, datetime
from pymongo import MongoClient
import httpx

def main() -> None:
    assert os.environ.get("GITHUB_ACTIONS") == "true"
    url = os.environ["MONGODB_URL"]
    assert "127.0.0.1:27019/qdip_e2e?" in url
    client = MongoClient(url, serverSelectionTimeoutMS=5000)
    db = client.get_default_database()
    result = db["org_api_keys"].update_one(
        {"org_id": "rr-e2e-org-b", "id": "rr-e2e-key-b", "revoked_at": None},
        {"$set": {"revoked_at": datetime.now(UTC)}},
    )
    assert result.modified_count == 1
    client.close()
    with httpx.Client(timeout=15) as http:
        response = http.get(
            "http://127.0.0.1:8000/api/v1/readiness-recovery/executions/unknown",
            headers={"x-api-key": os.environ["E2E_KEY_B"]},
        )
    assert response.status_code == 401, "Revoked org credential was accepted"
    print("RR_LIVE_ORG_KEY_REVOCATION=PASS")

if __name__ == "__main__":
    main()
