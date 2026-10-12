#!/usr/bin/env bash
# Native Mongo and real backend tests, private tracebacks suppressed.
set -euo pipefail
[[ "$GITHUB_ACTIONS" == "true" ]] || exit 2
python suite/scripts/safe_stage.py --timeout 900 backend-install -- python -m pip install -e './backend[dev]'
bash suite/scripts/install_mongo_native.sh
bash suite/scripts/start_mongo_native.sh
(
  cd backend
  if [[ "${RR_E2E_ONLY:-0}" != "1" ]]; then
    python ../suite/scripts/safe_stage.py --timeout 300 mongodb-integration -- \
      python -m pytest -q tests/plugins/readiness_recovery/test_mongo_integration.py
  fi
  # This is a real, isolated MongoDB backup/drop/restore/recheck E2E,
  # not a unit test; retain it in RR E2E-only qualification.
  python ../suite/scripts/safe_stage.py --timeout 300 mongodb-recovery -- \
    bash ../suite/scripts/restore_rr_native.sh
)
python suite/scripts/provision_tenants.py
echo 'E2E_NATIVE_BOOTSTRAP=PASS'
