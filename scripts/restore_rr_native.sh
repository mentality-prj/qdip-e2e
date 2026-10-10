#!/usr/bin/env bash
# ONLY on ephemeral GH runner. Destructively operates on hardcoded synthetic DB.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == 'true' ]] || {
  echo 'Destructive restore test restricted to GitHub Actions ephemeral runner.' >&2; exit 2;
}
[[ "$RR_TEST_MONGODB_URL" == 'mongodb://127.0.0.1:27019/?replicaSet=rrtest&directConnection=true' ]] || exit 2
BACKUP="$RUNNER_TEMP/rr-native-synthetic.archive"
python scripts/verify_rr_recovery_records.py seed
mongodump --quiet --host 127.0.0.1 --port 27019 \
  --db rr_disposable_restore_check --archive="$BACKUP"
test -s "$BACKUP"
mongosh --quiet --host 127.0.0.1 --port 27019 --eval '
  const dbName = "rr_disposable_restore_check";
  const result = db.getSiblingDB(dbName).dropDatabase();
  if (result.ok !== 1) quit(2);
'
mongorestore --quiet --host 127.0.0.1 --port 27019 \
  --archive="$BACKUP" --nsInclude='rr_disposable_restore_check.*'
python scripts/verify_rr_recovery_records.py verify
python scripts/verify_rr_recovery_records.py tamper-check
rm -f "$BACKUP"
echo 'RR_NATIVE_REAL_BACKUP_RESTORE=PASS'
