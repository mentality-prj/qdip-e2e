#!/usr/bin/env bash
# Install real remote SDK as a separate Python distribution, not in QDIP venv.
set -euo pipefail
python -m venv "$RUNNER_TEMP/qdip-independent-worker"
"$RUNNER_TEMP/qdip-independent-worker/bin/python" -m pip install --disable-pip-version-check \
  ./backend/packages/qdip_remote_sdk
"$RUNNER_TEMP/qdip-independent-worker/bin/python" -m pip install --disable-pip-version-check --no-deps \
  ./backend/examples/sdk_remote_demos
"$RUNNER_TEMP/qdip-independent-worker/bin/python" -c \
  'import qdip_remote_sdk,staffing_plugin; print("INDEPENDENT_WORKER_INSTALL=PASS")'
export QDIP_REMOTE_URL='ws://127.0.0.1:8000/api/v1/remote-plugins/connect'
export QDIP_REMOTE_API_KEY="$E2E_WORKER_KEY"
"$RUNNER_TEMP/qdip-independent-worker/bin/qdip-worker" \
  --handler staffing_plugin:make_spec --plugin-id staffing \
  --capability-id staffing.plan > "$RUNNER_TEMP/qdip-worker.log" 2>&1 &
echo $! > "$RUNNER_TEMP/qdip-worker.pid"
