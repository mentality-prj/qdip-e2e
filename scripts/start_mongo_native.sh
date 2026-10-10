#!/usr/bin/env bash
# Genuine mongod 8.x native process, local-only, clean GitHub runner.
set -euo pipefail
mkdir -p "$RUNNER_TEMP/mongodb/rrtest"
mongod --port 27019 --bind_ip 127.0.0.1 --replSet rrtest \
  --dbpath "$RUNNER_TEMP/mongodb/rrtest" --logpath "$RUNNER_TEMP/mongodb/mongod.log" \
  --fork
python "$(dirname "$0")/start_replica.py"
