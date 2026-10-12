#!/usr/bin/env bash
# Native Mongo and real backend tests, private tracebacks suppressed.
set -euo pipefail
[[ "$GITHUB_ACTIONS" == "true" ]] || exit 2
python suite/scripts/safe_stage.py --timeout 900 backend-install -- python -m pip install -e './backend[dev]'
bash suite/scripts/install_mongo_native.sh
bash suite/scripts/start_mongo_native.sh
if [[ "${RR_E2E_ONLY:-0}" != "1" ]]; then
  (
    cd backend
    python ../suite/scripts/safe_stage.py --timeout 300 mongodb-integration -- \
      python -m pytest -q tests/plugins/readiness_recovery/test_mongo_integration.py
    python ../suite/scripts/safe_stage.py --timeout 300 mongodb-recovery -- \
      bash ../suite/scripts/restore_rr_native.sh
  )
fi
python suite/scripts/provision_tenants.py
echo 'E2E_NATIVE_BOOTSTRAP=PASS'
