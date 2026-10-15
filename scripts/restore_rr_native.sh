#!/usr/bin/env bash
# ONLY on ephemeral GH runner. Destructively operates on hardcoded synthetic DB.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == 'true' ]] || {
  echo 'Destructive restore test restricted to GitHub Actions ephemeral runner.' >&2; exit 2;
}
[[ "$RR_TEST_MONGODB_URL" == 'mongodb://127.0.0.1:27019/?replicaSet=rrtest&directConnection=true' ]] || exit 2
BACKUP="$RUNNER_TEMP/rr-native-synthetic.archive"
trap 'rm -f "$BACKUP"' EXIT
python scripts/verify_rr_recovery_records.py seed
mongodump --quiet --host 127.0.0.1 --port 27019 \
  --db rr_disposable_restore_check --archive="$BACKUP"
test -s "$BACKUP"
# Reference RTO clock starts immediately before destructive DROP, includes
# mongorestore AND complete production-model / HMAC verification.
rr_restore_begin_ns="$(python -c 'import time; print(time.monotonic_ns())')"
mongosh --quiet --host 127.0.0.1 --port 27019 --eval '
  const dbName = "rr_disposable_restore_check";
  const result = db.getSiblingDB(dbName).dropDatabase();
  if (result.ok !== 1) quit(2);
'
mongorestore --quiet --host 127.0.0.1 --port 27019 \
  --archive="$BACKUP" --nsInclude='rr_disposable_restore_check.*'
python scripts/verify_rr_recovery_records.py verify
rr_restore_end_ns="$(python -c 'import time; print(time.monotonic_ns())')"
python -c 'import sys; print("RR_NATIVE_DISPOSABLE_RESTORE_RTO_MS=" + str((int(sys.argv[2]) - int(sys.argv[1])) // 1_000_000))' "$rr_restore_begin_ns" "$rr_restore_end_ns"
echo 'RR_NATIVE_DISPOSABLE_RPO_LOST_RECORDS=0 (fixed synthetic five-collection fixture only)'
python scripts/verify_rr_recovery_records.py tamper-check
echo 'RR_NATIVE_REAL_BACKUP_RESTORE=PASS (includes sealed economic archives)'
