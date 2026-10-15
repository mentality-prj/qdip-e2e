# QDIP Cloudflare Security Gate v1

Action: **Actions → QDIP Cloudflare Security Gate → Run workflow** in `qdip-ai/qdip-e2e`.

This is a **manual, non-merge-gating release-security review**, separate from existing
E2E CI. No scheduled/push/PR triggers and no write permission to private sources.
The source checkout and Cloudflare skill are pinned to recorded immutable SHAs.
The skill version is `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8`.
The action runs the actual six-phase skill via GitHub Copilot CLI and validates
its JSON outputs with the exact upstream validators, without marking missing work PASS.

## Run inputs

- `target`: `vhv` (`qdip-ai/qdip-personal-secretary`), `core`, `web` or `doctor`.
- `source_ref`: source branch/commit, preferably a **full immutable SHA**. For VHV
  PR #47 at implementation time, `84882b4a104496072b7666e146153424d19eb5f4`.
- `expected_sha`: optional full SHA; set this when auditing a branch to reject drift.
- Credential: `QDIP_READ_TOKEN` in `qdip-e2e` Actions secrets requires
  **Contents: read** on the selected private repository. It is never exposed to
  the Copilot CLI step or to uploaded evidence.
- Copilot CLI uses the built-in `GITHUB_TOKEN` with `copilot-requests: write`.
  This works only if the QDIP organization allows Copilot CLI requests billed to it.
  **Not a free guarantee**: this workflow can incur AI-credit charges. It is
  intentionally manual and sets `--max-ai-credits 30` (soft cost cap; currently
  at least 30 AI credits required by GitHub; credit is $0.01 USD).

## Security and result semantics

The public E2E repository does **not** store detailed findings, source snippets,
agent transcripts, attack paths, PII, or private full audit reports. These stay
only in the temporary hosted runner and are destroyed with it. A sanitized
`verdict.json` artifact contains only source SHA, skill SHA, status, counts and
completeness flags; retain for 14 days. **Never upload raw findings to public
Actions artifacts or public Issues.** Private finding triage/report retention
requires a separate explicitly approved secure storage path.

- `PASS`: all required reports exist, both upstream schema validators pass,
  source HEAD matches expected SHA, worktree untouched, Copilot finished, no
  unresolved leads, and coverage ledger contains no incomplete units or
  confirmed high/critical findings. PASS is a source-audit outcome only, **not**
  a substitute for live PostgreSQL/GDPR/Zitadel E2E, secrets/SAST scans or
  production authorization.
- `BLOCKED`: complete validated audit with confirmed high/critical findings.
- `INCOMPLETE`: agent/model/policy failure, missing report, malformed JSON,
  missing coverage, stale/dirty source, unresolved candidates, or incomplete units.

Both `BLOCKED` and `INCOMPLETE` fail the Action, without blocking private-repo
development CI or merge. The agent has **no shell or network tools** and may not
execute target-controlled code. Without a separately provisioned OS-enforced
sandbox, dynamic exploitation cannot be marked confirmed; evidence requiring
execution remains `needs_validation`. This deliberate fail-closed mode is
a code-only audit, **not the complete production release decision**.

For VHV irreversible GDPR erase, require isolated PostgreSQL qualification and
negative authenticated E2E in addition to this Action before release.
