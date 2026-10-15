# QDIP Independent Security Gate (no mandatory AI or additional AI billing)

Workflow: [QDIP Independent Security Gate](../.github/workflows/security-gate.yml)
in the **public** `qdip-ai/qdip-e2e` repository.

This is a **manual** pre-release **static security check**. It is not part
of push/PR CI in private repositories. It does not call Copilot, Gemini,
Claude API or other AI inference endpoints and requires **no AI API key**.

## Run from GitHub Actions

1. Actions → **QDIP Independent Security Gate** → Run workflow.
2. Choose `target`: `vhv` (`qdip-ai/qdip-personal-secretary`), `core`,
   `web` or `doctor`.
3. Supply `source_ref`: preferably a full immutable 40-character commit SHA.
   For a branch, also set `expected_sha` to prevent moving-ref ambiguity.
4. Add the fine-grained personal access token as **qdip-e2e → Settings →
   Secrets and variables → Actions → Repository secrets** named
   `QDIP_SECURITY_READ_TOKEN`. Grant the token read-only Contents permission
   on the selected private source repository. The GitHub workflow checks
   whether the secret is configured without printing its value; checkout
   verifies whether the access works. Existing secrets are not readable from
   the GitHub UI.

The workflow records exact Git commit SHA, confirms clean source worktree,
and runs only the following trusted scanners. No `npm install`, build,
project tests, project scripts or untrusted source-controlled hooks execute.

| Tool | Purpose | Policy |
| --- | --- | --- |
| Gitleaks v8.24.3 | Working-tree credential patterns | Any finding BLOCKED |
| Semgrep OSS v1.134.0 | Small local ruleset (`security/semgrep.yml`) | ERROR BLOCKED; WARNING report-only |
| Trivy via pinned official Action v0.36.0 | Dependency vulnerabilities and configuration | HIGH/CRITICAL BLOCKED |

**This is not exhaustive SAST**: local Semgrep rules are deliberately small,
Trivy DB coverage depends on package ecosystems, and Gitleaks scans the
checked-out working tree, not the full Git history. Future rules are reviewed
and versioned in this E2E repository. Scanners download their public tool
packages / vulnerability databases. GitHub Actions runner time and network
quotas still apply; only *extra AI inference billing* is eliminated.

## Results and privacy boundary

- **PASS**: all three scanners completed, source SHA/worktree validated, no
  findings triggering the static policy. It means **static checks only**.
- **BLOCKED**: static scanners report a policy-blocking secret, high severity
  SAST finding, HIGH/CRITICAL dependency advisory or misconfiguration.
  Scanner findings need human triage; do not call them independently confirmed.
- **INCOMPLETE**: missing token/checkout, scanner crash, missing/invalid output,
  moved source ref, changed worktree or incomplete evidence.

Both BLOCKED and INCOMPLETE fail the workflow but do **not** block private
repository development. The public Actions artifact contains ONLY a minimal
`verdict.json` with SHA, statuses, and counts, and never raw private code,
credential matches, paths, private audit reports or scanner transcripts.
Those are retained only temporarily within the ephemeral Actions runner and
are discarded when it ends. Remediation requires a separate secure private
review mechanism or rerun in a secure developer workspace.

`ai_audit: NOT_RUN` and `production_qualified: false` are always explicit.
A static PASS **cannot** certify a production release or GDPR compliance.
VHV deletion release still requires isolated PostgreSQL + negative authorized
Zitadel E2E, backup/lifecycle review, and an explicit human release decision.

## Optional Cloudflare Skill audit using existing Claude setup

The independent [Cloudflare Security Audit Skill](https://github.com/cloudflare/security-audit-skill)
remains **optional**. Run its six-phase assessment separately using an existing
Claude environment when acceptable under code-sharing policies. The skill
requires an AI agent for a full audit; the deterministic workflow does **not**
pretend to run those phases.

A secure local/private workspace may call
`node scripts/security_gate.mjs evaluate` with `SECURITY_TARGET`,
`SOURCE_REF`, `EXPECTED_SHA`, `SKILL_SHA`, `SOURCE_DIR`,
`SKILL_DIR`, `GATE_REPORT_DIR` and `SANITIZED_DIR` after receiving
the seven required private audit files. This optional evaluator uses the
upstream Cloudflare JSON validators and reports PASS/BLOCKED/INCOMPLETE
for the **separate AI audit only**. It does not modify or inflate the
deterministic workflow outcome; never upload its detailed reports into
public qdip-e2e artifacts. No AI provider is automatically installed.
