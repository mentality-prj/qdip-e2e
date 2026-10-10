# QDIP independent end-to-end tests

Independent GitHub Actions suite (manual E2E and public-repository SHA polling) for [QDIP](https://github.com/mentality-prj/dzvin-intelligence-platform) and [Observatory](https://github.com/mentality-prj/dip-observatory).

**Runs native MongoDB 8.0 replica set, FastAPI, Kernel/CP-SAT, independent Python SDK Worker, Next.js and Chromium Playwright on a GitHub-hosted Ubuntu runner. No Docker, no in-process fake persistence and no customer data.**

## Launch

1. Set **this E2E repository to Public**. The backend can remain private. Scheduled polling is disabled at the job level while this E2E repository is Private.
2. Configure repository secret `QDIP_READ_TOKEN`: fine-grained token with **Contents: Read-only** on exactly `mentality-prj/dzvin-intelligence-platform` and `mentality-prj/dip-observatory`. Never commit a token, use it as an Actions input, or expose it in logs. This public test repo does not need private source copied into it.
3. In **Actions → QDIP independent real E2E → Run workflow** choose source refs (defaults: backend `feat/rr-prod-01-normalized-source-import`, Observatory `feat/rr-production-operator-boundary`).
4. Read the **individual step results** and downloaded sanitized evidence artifact. All tested checkout SHAs are recorded.

The expensive test workflow accepts `workflow_dispatch` and `repository_dispatch` only. A separate lightweight `Watch QDIP Core (no Core Actions)` workflow polls once per hour at minute 17 UTC. Neither workflow runs on E2E repository pushes or PRs. Repository secrets are not available to unauthenticated visitors or ordinary public PRs.

## Automatic runs: NO GitHub Actions in the private Core

The former `dzvin-intelligence-platform/.github/workflows/dispatch-qdip-e2e.yml`
was **deleted from the active RR feature branch**. It never reached Core
`dev`. E2E now has **zero automatic Action jobs in the private Core**.

The only automatic watcher is in this **public E2E repository**:
`.github/workflows/watch-core.yml` scheduled for minute 17 of each hour.
It invokes `scripts/watch_core.py` to check `dev` and
`feat/rr-prod-01-normalized-source-import` through the GitHub REST API using
the E2E repository's already configured `QDIP_READ_TOKEN`. Branches without
the required RR reference proof are deferred until ready.

For an eligible new SHA, the watcher dispatches `qdip-core-updated` with
the **immutable Core SHA**. `real-e2e.yml` runs tests only in this E2E
repository. The watcher records each observed source commit, Observatory ref and E2E test-suite
fingerprint in the durable `.state/core-watch.json` ledger in this **E2E
repository**. Docs-only changes advance the observed head without triggering
the expensive test. A new source commit or changed test-suite code produces
a new qualification identity. The terminal E2E result records
`PASS`, `TEST_FAIL`, or `INFRA_FAIL` with the run ID. Failures are
not silently converted to PASS or retried indefinitely; manual reruns are
available. A stalled dispatch has one bounded retry after six hours.

**Runner-cost guard:** both `watch-core.yml` AND
`real-e2e.yml` use `if: github.event.repository.private == false`.
When the E2E repository reports Private, neither scheduled nor manually
started E2E jobs allocate a runner. **GitHub currently
reports this repository as private**, so change its visibility to Public
under `Settings → General → Danger Zone → Change repository visibility`.
The API connector does not expose the visibility-changing operation.

**Only one secret is required:** `QDIP_READ_TOKEN` in **this E2E repository**,
fine-grained `Contents: Read-only` on the source Core and Observatory.
The watcher uses its own `GITHUB_TOKEN` for a self-repository dispatch
and an Actions artifact read, not a cross-repo write credential. The former
backend-side `QDIP_E2E_DISPATCH_TOKEN` is **no longer necessary** and should
be revoked/deleted from backend repository Secrets if it was created.

**Important:** Core still contains independent historical CI/GF2 workflows.
Removing the E2E trigger does not disable those unrelated workflows. To
enforce literally **zero Actions minutes in Core**, additionally set
`dzvin-intelligence-platform → Settings → Actions → General → Actions
permissions → Disable actions`. This is an administrative action, does
not affect this E2E repo polling Core's source via read-only token, and
cannot be performed with this connector.

GitHub may delay scheduled jobs, and scheduled workflows can be disabled
after long inactivity in public repositories. The watcher provides
eventual detection, not instant on-push delivery.

Public-repository logs are deliberately sanitized: private Core/Observatory
build commands, pytest, and Playwright subprocesses write raw output only
under the ephemeral runner's `RUNNER_TEMP`. Raw logs and Playwright JSON
results are NOT uploaded as artifacts. Public evidence contains only commit
SHAs and explicitly bounded outcome summaries. This prevents accidental
traceback/source exposure but means detailed private diagnostics require a
separately authorized restricted debugging process. Do not enable raw debug
logging on public runs.

The real-service tests now use independent versioned civilian API JSON
(`fixtures/rr_reference_api_v1.json`) instead of importing a Core-owned
fixture. They exercise real concurrent replans (one head wins),
process restart with retained MongoDB history, API-key revocation,
SDK Worker disconnect and fail-closed Chromium coverage (3 required
tests, zero skipped).

**Least privilege:** the integration job executing private source has only
`contents: read`. A separate public-suite-only finalizer job downloads
a sanitized stage-status artifact and updates the durable ledger with
`contents: write`. No private backend is checked out into this
write-capable job. The public `Validate public E2E suite` workflow
runs Actionlint, Python syntax and Bash syntax checks on suite changes,
but allocates no runner until this repository is Public.

**Limits:** E2E is `NOT_RUN` until an actual public hosted-runner
job succeeds. Browser login still tests temporary reference-password
authentication, not final OIDC; single-node Mongo replica does not
establish HA or production RTO/RPO.

The Observatory ref in automatic runs is currently the staged
`feat/rr-production-operator-boundary`; each E2E records its exact
checkout SHA. Once that frontend changes, update the configured ref in
`scripts/watch_core.py`. Stage browser operator authentication is not
production OIDC validation.

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
