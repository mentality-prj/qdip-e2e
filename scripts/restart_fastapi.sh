#!/usr/bin/env bash
# Restart real localhost FastAPI process; preserve native MongoDB state.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == "true" ]] || exit 2
[[ -f "$RUNNER_TEMP/qdip-fastapi.pid" ]] || exit 2
pid="$(cat "$RUNNER_TEMP/qdip-fastapi.pid")"
[[ "$pid" =~ ^[0-9]+$ ]] || exit 2
kill "$pid"
for attempt in $(seq 1 40); do
  if ! kill -0 "$pid" 2>/dev/null; then break; fi
  sleep 0.25
done
if kill -0 "$pid" 2>/dev/null; then
  echo 'Existing API process did not terminate' >&2
  exit 1
fi
(cd backend && exec python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 \
  > "$RUNNER_TEMP/qdip-fastapi-restarted.log" 2>&1) &
echo $! > "$RUNNER_TEMP/qdip-fastapi.pid"
curl -fsS --retry 30 --retry-connrefused --retry-delay 1 --max-time 35 \
  http://127.0.0.1:8000/health >/dev/null
echo 'FASTAPI_REAL_PROCESS_RESTART=PASS'
