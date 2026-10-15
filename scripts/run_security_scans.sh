#!/usr/bin/env bash
# Only invoke trusted scanners. Never execute project package scripts, builds, tests or hooks.
set -euo pipefail
: "${SOURCE_DIR:?}"
: "${GATE_REPORT_DIR:?}"
: "${GATE_TOOLS_BIN:?}"
: "${GATE_SEMGREP_CONFIG:?}"
mkdir -p "$GATE_REPORT_DIR"
chmod 700 "$GATE_REPORT_DIR"

scan() {
  local name="$1"
  shift
  local result=0
  "$@" > "$GATE_REPORT_DIR/$name.private.log" 2>&1 || result=$?
  printf '%s\n' "$result" > "$GATE_REPORT_DIR/$name.exit"
  printf 'QDIP_SECURITY_SCANNER_%s_FINISHED=1\n' "$name"
}
scan gitleaks "$GATE_TOOLS_BIN/gitleaks" dir "$SOURCE_DIR" \
  --redact --no-banner --report-format json --report-path "$GATE_REPORT_DIR/gitleaks.json"
# Gitleaks may omit its JSON when it finds nothing. Normalize only on successful execution.
if [[ "$(cat "$GATE_REPORT_DIR/gitleaks.exit")" == 0 ]] && [[ ! -f "$GATE_REPORT_DIR/gitleaks.json" ]]; then
  printf '[]\n' > "$GATE_REPORT_DIR/gitleaks.json"
fi

scan semgrep "$GATE_TOOLS_BIN/semgrep" scan "$SOURCE_DIR" \
  --config "$GATE_SEMGREP_CONFIG" \
  --metrics=off --disable-version-check --no-git-ignore --error --strict \
  --exclude '**/node_modules/**' --exclude '**/.next/**' \
  --json --output "$GATE_REPORT_DIR/semgrep.json"

# Trivy runs independently through the pinned official setup/action.
# All private reports and scanner diagnostics remain in RUNNER_TEMP.
