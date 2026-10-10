# QDIP independent end-to-end tests

Independent, manually triggered GitHub Actions suite for [QDIP](https://github.com/mentality-prj/dzvin-intelligence-platform) and [Observatory](https://github.com/mentality-prj/dip-observatory).

**Runs native MongoDB 8.0 replica set, FastAPI, Kernel/CP-SAT, independent Python SDK Worker, Next.js and Chromium Playwright on a GitHub-hosted Ubuntu runner. No Docker, no in-process fake persistence and no customer data.**

## Launch

1. Keep this E2E repository **public** if desired. The backend and Observatory can remain private.
2. Configure repository secret `QDIP_READ_TOKEN`: fine-grained token with **Contents: Read-only** on exactly `mentality-prj/dzvin-intelligence-platform` and `mentality-prj/dip-observatory`. Never commit a token, use it as an Actions input, or expose it in logs. This public test repo does not need private source copied into it.
3. In **Actions → QDIP independent real E2E → Run workflow** choose source refs (defaults: backend `feat/rr-prod-01-normalized-source-import`, Observatory `feat/rr-production-operator-boundary`).
4. Read the **individual step results** and downloaded sanitized evidence artifact. All tested checkout SHAs are recorded.

The workflow uses `workflow_dispatch` only; it does not run on push, PRs or a schedule. Repository secrets are unavailable to unauthenticated visitors and ordinary public PRs.

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
