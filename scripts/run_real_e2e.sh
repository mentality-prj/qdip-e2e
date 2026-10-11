#!/usr/bin/env bash
# Live HTTP/Mongo/Worker/Browser. Raw private-source output stays in RUNNER_TEMP.
set -euo pipefail
[[ "$GITHUB_ACTIONS" == "true" ]] || exit 2
test -n "$E2E_KEY_A"
test -n "$RR_E2E_OPERATOR_PASSWORD"
test -n "$RR_E2E_API_REQUEST_PATH"
RR_E2E_CONTRACT_MODE="${RR_E2E_CONTRACT_MODE:-legacy}"
case "$RR_E2E_CONTRACT_MODE" in
  legacy|rr-plugin-v1) ;;
  *) echo 'RR_E2E_CONTRACT_MODE=INVALID' >&2; exit 2 ;;
esac
(cd backend && exec python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 \
  > "$RUNNER_TEMP/qdip-fastapi.log" 2>&1) &
echo $! > "$RUNNER_TEMP/qdip-fastapi.pid"
curl --fail --silent --retry 35 --retry-delay 1 --retry-connrefused \
  http://127.0.0.1:8000/health >/dev/null
(
  cd backend
  python ../suite/scripts/safe_stage.py --timeout 180 backend-http -- \
    python ../suite/scripts/http_rr_e2e.py
)
if [[ "$RR_E2E_CONTRACT_MODE" == "rr-plugin-v1" ]]; then
  (
    cd backend
    python ../suite/scripts/safe_stage.py --timeout 180 rr-plugin-http -- \
      python ../suite/scripts/http_rr_plugin_e2e.py
  )
fi
python suite/scripts/safe_stage.py --timeout 120 backend-restart -- \
  bash suite/scripts/restart_fastapi.sh
(
  cd backend
  python ../suite/scripts/safe_stage.py --timeout 120 backend-restart-verify -- \
    python ../suite/scripts/check_fastapi_restart.py
)
python suite/scripts/safe_stage.py --timeout 70 rr-auth-revocation -- python suite/scripts/check_revocation.py
if [[ "$RR_E2E_CONTRACT_MODE" == "rr-plugin-v1" ]]; then
  # Copy BEFORE typecheck/build, so the real Web TypeScript compiler checks
  # the independent E2E spec against the exact checked-out application types.
  cp suite/scripts/rr_plugin_browser.spec.ts observatory/e2e/rr_plugin_real_e2e.spec.ts
  SPEC='e2e/rr_plugin_real_e2e.spec.ts'
else
  SPEC='e2e/rr-production-operator.spec.ts'
fi
(
  cd observatory
  python ../suite/scripts/safe_stage.py --timeout 700 observatory-install -- pnpm install --frozen-lockfile
  python ../suite/scripts/safe_stage.py --timeout 300 observatory-lint -- pnpm lint
  python ../suite/scripts/safe_stage.py --timeout 300 observatory-typecheck -- pnpm typecheck
  python ../suite/scripts/safe_stage.py --timeout 300 observatory-unit -- pnpm test
  python ../suite/scripts/safe_stage.py --timeout 700 observatory-build -- pnpm build
  python ../suite/scripts/safe_stage.py --timeout 700 browser-install -- pnpm exec playwright install --with-deps chromium
)
python suite/scripts/safe_stage.py --timeout 180 sdk-install -- bash suite/scripts/start_remote_worker.sh
python suite/scripts/safe_stage.py --timeout 180 sdk-e2e -- python suite/scripts/http_sdk_e2e.py
python suite/scripts/safe_stage.py --timeout 80 sdk-negative -- python suite/scripts/check_remote_worker_failure.py
echo '127.0.0.1 observatory.localhost' | sudo tee -a /etc/hosts >/dev/null
test -s "$RR_E2E_API_REQUEST_PATH"
(
  cd observatory
  python ../suite/scripts/safe_stage.py --timeout 350 \
    --output "$RUNNER_TEMP/qdip-browser-report.json" browser-e2e -- \
    pnpm exec playwright test "$SPEC" \
      --project=chromium --workers=1 --retries=0 --reporter=json --forbid-only
)
python suite/scripts/safe_stage.py --timeout 40 test-report -- python suite/scripts/check_browser_report.py
echo 'QDIP_REAL_NATIVE_E2E=PASS (not production qualification)'
