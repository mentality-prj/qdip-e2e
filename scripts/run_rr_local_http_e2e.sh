#!/usr/bin/env bash
# RR local, *real HTTP + Mongo + Kernel* integration E2E without GitHub Actions.
# Does not start Docker, does not provision a DB, and never connects to live data.
set -euo pipefail
[[ "${RR_LOCAL_E2E_CONFIRMED:-}" == 'DISPOSABLE_ONLY' ]] || {
  echo 'RR_LOCAL_E2E=REJECTED: set RR_LOCAL_E2E_CONFIRMED=DISPOSABLE_ONLY' >&2
  exit 2
}
EXPECTED_DB='mongodb://127.0.0.1:27019/qdip_e2e?replicaSet=rrtest&directConnection=true'
[[ "${MONGODB_URL:-}" == "$EXPECTED_DB" ]] || {
  echo 'RR_LOCAL_E2E=REJECTED: MONGODB_URL must be exact disposable loopback replica' >&2
  exit 2
}
[[ -n "${E2E_KEY_A:-}" && -n "${E2E_KEY_B:-}" && "$E2E_KEY_A" != "$E2E_KEY_B" ]] || {
  echo 'RR_LOCAL_E2E=REJECTED: two distinct disposable tenant keys required' >&2
  exit 2
}
[[ "${GITHUB_ACTIONS:-}" != 'true' ]] || {
  echo 'RR_LOCAL_E2E=REJECTED: use the independent hosted runner in Actions' >&2
  exit 2
}
[[ -n "${RR_ECONOMIC_EVIDENCE_HMAC_KEY:-}" && "${#RR_ECONOMIC_EVIDENCE_HMAC_KEY}" == 64 ]] || {
  echo 'RR_LOCAL_E2E=REJECTED: independent economic evidence HMAC key required' >&2
  exit 2
}
[[ "${RR_SOURCE_POLICIES_JSON:-}" != '' ]] || {
  echo 'RR_LOCAL_E2E=REJECTED: RR_SOURCE_POLICIES_JSON must be configured in Core' >&2
  exit 2
}
command -v python >/dev/null || {
  echo 'RR_LOCAL_E2E=REJECTED: Python 3 environment unavailable' >&2
  exit 2
}
python - <<'PY'
import json, os
cfg = json.loads(os.environ["RR_SOURCE_POLICIES_JSON"])
source = cfg.get("rr-e2e-org-a", {})
assert source.get("source_system") == "rr-civilian-workshop-example", "wrong source policy"
assert "v1" in source.get("allowed_source_versions", []), "missing reference v1"
PY
if [[ -z "${RUNNER_TEMP:-}" ]]; then
  RUNNER_TEMP="$(mktemp -d "${TMPDIR:-/tmp}/qdip-rr-local-e2e.XXXXXXXX")"
  export RUNNER_TEMP
fi
[[ -d "$RUNNER_TEMP" ]] || {
  echo 'RR_LOCAL_E2E=REJECTED: RUNNER_TEMP must be a directory' >&2
  exit 2
}
export RR_E2E_LOCAL=1 RR_E2E_ONLY=1
echo 'Running real RR HTTP/Mongo E2E against disposable localhost services.'
python "$(dirname "$0")/rr_new_functional_http_e2e.py"
echo "RR_LOCAL_HTTP_E2E=PASS"
echo "RR_LOCAL_EVIDENCE=$RUNNER_TEMP/qdip-rr-functional-state.json"
echo 'Core/Web browser E2E and actual Zitadel login are separate acceptance gates.'
