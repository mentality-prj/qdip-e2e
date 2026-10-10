# QDIP independent end-to-end tests

Independent, manually triggered GitHub Actions suite for [QDIP](https://github.com/mentality-prj/dzvin-intelligence-platform) and [Observatory](https://github.com/mentality-prj/dip-observatory).

**Runs native MongoDB 8.0 replica set, FastAPI, Kernel/CP-SAT, independent Python SDK Worker, Next.js and Chromium Playwright on a GitHub-hosted Ubuntu runner. No Docker, no in-process fake persistence and no customer data.**

## Launch

1. Keep this E2E repository **public** if desired. The backend and Observatory can remain private.
2. Configure repository secret `QDIP_READ_TOKEN`: fine-grained token with **Contents: Read-only** on exactly `mentality-prj/dzvin-intelligence-platform` and `mentality-prj/dip-observatory`. Never commit a token, use it as an Actions input, or expose it in logs. This public test repo does not need private source copied into it.
3. In **Actions → QDIP independent real E2E → Run workflow** choose source refs (defaults: backend `feat/rr-prod-01-normalized-source-import`, Observatory `feat/rr-production-operator-boundary`).
4. Read the **individual step results** and downloaded sanitized evidence artifact. All tested checkout SHAs are recorded.

The workflow uses `workflow_dispatch` only; it does not run on push, PRs or a schedule. Repository secrets are unavailable to unauthenticated visitors and ordinary public PRs.

## Automatic runs after QDIP Core changes

The backend's existing RR implementation branch now includes
`.github/workflows/dispatch-qdip-e2e.yml`. It dispatches automatically on
code/config changes pushed to `feat/rr-prod-01-normalized-source-import`, and
to `dev` once that workflow is merged there. It sends the **exact backend
commit SHA**, not a moving branch. Docs-only changes don't trigger expensive
E2E runs. A fresh auto-dispatched run cancels an older *automatic* E2E run;
manually started runs use a separate concurrency group.

The receiving suite listens to `repository_dispatch: qdip-core-updated`
and also supports `workflow_dispatch` (manual runs) as before.

**One-time additional secret — configure in the BACKEND repo
`mentality-prj/dzvin-intelligence-platform`:**

- `QDIP_E2E_DISPATCH_TOKEN`: fine-grained PAT with `Contents: Read and write`
  on **only** `mentality-prj/qdip-e2e`. Used solely to send an event using
  `POST /repos/mentality-prj/qdip-e2e/dispatches`.
- The already documented `QDIP_READ_TOKEN` stays in the **E2E repo** and has
  only `Contents: Read-only` access to both source repos.

These are **different permission boundaries**. Do not place either credential
in a public workflow file, CLI history, or source code. The sender workflow
fails explicitly if the dispatch secret is absent. A successful dispatch
confirms only that an E2E run was *requested*, not that it passed.

This currently tests the separate Observatory feature branch
`feat/rr-production-operator-boundary`. Once that UI is merged, change the
dispatch's `observatory_ref` to the qualified release commit or `dev`.
For staged feature refs, the result only qualifies the **exact source SHA
combination printed by the run**, not all revisions or the production build.

## What is tested

- Genuine MongoDB transaction/competing-replan tests in a single-node replica set; this is not HA/failover evidence.
- Real `mongodump → dropDatabase → mongorestore` on a hardcoded **disposable synthetic test database**, followed by persisted RR history/head/audit checks.
- Real HTTP FastAPI → CP-SAT Kernel → MongoDB: create, retry, replan, tenant isolation, history, integrity, replay and export.
- Independent separately installed Python Remote SDK Worker via WebSocket → live FastAPI → server-owned Kernel.
- Chromium Playwright → actual Next.js Observatory operator UI → live QDIP API / real MongoDB.

**Current Observatory branch uses a shared operator password as a staging test only. This is NOT final OAuth/OIDC qualification.** No live customer data, no cross-company training, no ROI claim, no enterprise security/SLA/HA assertion.

## Scope and gates

`E2E PASS` means only that the specified real integration tests passed on the recorded SHAs. The following remain separate release gates: proper OAuth/OIDC per-user authorization, internet-facing security, backup RTO/RPO, multi-node reliability, deployment review and customer-specific acceptance.

Backend roadmap [#270](https://github.com/mentality-prj/dzvin-intelligence-platform/issues/270), RR [#274](https://github.com/mentality-prj/dzvin-intelligence-platform/issues/274). **Do not infer product qualification from this suite alone.**

## Public repo safety

- Source checkouts use a read-only token and `persist-credentials: false`.
- All services listen on localhost; synthetic-only test content.
- Random test credentials are masked and are not included in uploaded artifacts.
- Hosted-runner APT and pip/pnpm downloads are required; test output is retained for 7 days.
- An Actions job that never started or fails to install a dependency is **NOT_RUN/FAIL**, never a PASS.
