# RR local network E2E — no CI, no Docker requirement

This is a **real-service** acceptance path using the RR staged E2E branch.
It runs the same HTTP/Mongo/Kernel functional assertions as the hosted suite,
not a unit test or simulated persistence.

Prerequisites: an independently started QDIP Core on
`http://127.0.0.1:8000`, MongoDB replica set `rrtest` listening on
`127.0.0.1:27019`, and **disposable** DB `qdip_e2e`. Core must use this
same dedicated database and have two separate tenant keys already provisioned
with required RR decision/audit permissions; never use a production/staging
customer API key. Core also needs the environment value
`RR_SOURCE_POLICIES_JSON` mapping `rr-e2e-org-a` to an approved synthetic
`rr-civilian-workshop-example` source with version `v1`, max source age
at least 120 seconds and a zero/explicit clock skew. The E2E shell verifies
the local policy value, which must also be present in the running Core process.
The scripts **do not install Mongo, modify auth roles, or start a service**.

From the independent `qdip-e2e` checkout, after configuring environment
variables in your shell:

```bash
export RR_LOCAL_E2E_CONFIRMED=DISPOSABLE_ONLY
export MONGODB_URL='mongodb://127.0.0.1:27019/qdip_e2e?replicaSet=rrtest&directConnection=true'
export RR_ECONOMIC_EVIDENCE_HMAC_KEY='<64 hexadecimal digits, 32 random bytes; same as running Core>'
export RR_SOURCE_POLICIES_JSON='{"rr-e2e-org-a":{"source_system":"rr-civilian-workshop-example","allowed_source_versions":["v1"],"max_source_age_seconds":120,"max_future_skew_seconds":0}}'
# E2E_KEY_A and E2E_KEY_B must be separate keys of *synthetic* e2e tenants.
bash scripts/run_rr_local_http_e2e.sh
```

Install Python dependencies `httpx` and `pymongo` in your active local
Python environment if not already available through the QDIP backend venv.
The command fails closed if Mongo is not exactly the disposable
loopback test URL or if caller fails to opt into this isolated test.
It creates synthetic RR inputs, histories, economic snapshots/advice, and
temporarily edits **only** records it just created to verify tamper handling,
restoring them in `finally` blocks. It does not drop an entire database.
Outputs are a PASS marker and an opaque IDs/digests file in `RUNNER_TEMP`;
do not treat this as a live Zitadel browser/ERP/CMMS qualification.

The independent hosted E2E branch remains the separate full Core/Web/browser/
native Mongo backup-restore/restart runner; the local command above covers
only the real HTTP/Core/Kernel/Mongo economic and normalized-import flow.
Do not claim end-to-end browser/real IdP PASS from a local HTTP-only result.


Economic persistence is **not available** without
`RR_ECONOMIC_EVIDENCE_HMAC_KEY` (32 independent server-generated random bytes
encoded as exactly 64 lowercase/uppercase hex characters). Set the *same*
key in the already-running test Core and local shell. It must never be
committed to Git, copied from the MongoDB instance or shared with Next.js.
The hosted independent E2E runner provisions its own disposable key.
Replacing this key will prevent historical evidence verification; retain it
securely for the lifetime of archived records or migrate records under an
audited key-rotation procedure. Without it, only economic preflight is
available, and persisted advice routes fail with HTTP 503.
