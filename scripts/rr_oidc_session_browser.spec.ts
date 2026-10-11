import { readFileSync } from 'node:fs'
import { createHmac } from 'node:crypto'
import { expect, test } from '@playwright/test'

// This spec is owned by the independent E2E suite and copied to the checked-out
// qdip-web/e2e directory ONLY when the rr-plugin-v1 contract is required.
// The E2E fixture injects an ephemeral signed session; live Zitadel login is NOT tested.
// HTTP, Core, Mongo persistence and BFF authorization are never mocked.
const ORIGIN = 'http://observatory.localhost:3000'
const PAGE = `${ORIGIN}/en/readiness-recovery`
const ROUTE = `${ORIGIN}/api/rr-operator/kernel`

type CivilianRequest = {
  execution_id: string
  source: { source_system: string; snapshot_id: string; source_version: string; captured_at: string }
  ingested_at: string
  payload: { decision_id: string; operator_directives?: { excluded_job_ids: string[] } }
}


/**
 * Inject a locally signed QDIP test session to exercise the REAL OIDC BFF's
 * session authorization and signed Core audit on this isolated runner.
 * It deliberately does NOT test Zitadel login, PKCE, JWKS or callbacks.
 * Never use this fixture with production origin or production secrets.
 */
async function installIsolatedOidcSession(page: import('@playwright/test').Page) {
  const secret = process.env.QDIP_AUTH_COOKIE_SECRET ?? ''
  const issuer = process.env.ZITADEL_ISSUER ?? ''
  const clientId = process.env.ZITADEL_CLIENT_ID ?? ''
  const subject = process.env.QDIP_AUTH_OPERATOR_SUBJECTS ?? ''
  if (secret.length < 32 || issuer !== 'https://qdip-e2e.invalid' || clientId !== 'qdip-e2e-client' ||
      subject !== 'qdip-e2e-operator' || process.env.GITHUB_ACTIONS !== 'true')
    throw new Error('Isolated OIDC-session test configuration is missing or unsafe')
  const expiresAt = Math.floor(Date.now() / 1000) + 900
  const body = Buffer.from(JSON.stringify({sub: subject, issuer, clientId, expiresAt})).toString('base64url')
  const mac = createHmac('sha256', secret).update('session-v1:' + body).digest('base64url')
  await page.context().addCookies([{
    name: 'qdip_oidc_session',
    value: body + '.' + mac,
    domain: 'observatory.localhost',
    path: '/',
    httpOnly: true,
    secure: false,
    sameSite: 'Lax',
    expires: expiresAt,
  }])
}

function actualInput(): CivilianRequest {
  if (process.env.RR_E2E_CONTRACT_MODE !== 'rr-oidc-session-v1')
    throw new Error('The real plugin browser suite requires rr-plugin-v1 mode')
  const path = process.env.RR_E2E_API_REQUEST_PATH
  if (!path)
    throw new Error('The disposable RR API request fixture is required')
  const input = JSON.parse(readFileSync(path, 'utf8')) as CivilianRequest
  const unique = `${Date.now().toString(36)}-${process.pid.toString(36)}`
  const now = new Date().toISOString()
  input.execution_id = `rr-plugin-browser-${unique}-01`
  input.source.captured_at = now
  input.source.snapshot_id = `browser-snapshot-${unique}`
  input.ingested_at = now
  input.payload.decision_id = `civilian-browser-${unique}`
  return input
}

test('public RR is a read-only civilian input example, never a second solver', async ({ page }) => {
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
  const preview = page.getByTestId('rr-reference-preview')
  await expect(preview).toBeVisible()
  await expect(preview).toContainText('diagnostic-check')
  await expect(preview).toContainText('sensor-service')
  await expect(preview).toContainText('input fixture')
  await expect(preview).not.toContainText('Kernel optimal schedule')

  const deprecated = await page.request.post(`${ORIGIN}/readiness/scenarios`, {
    data: { input: { untrusted: true } },
  })
  expect(deprecated.status()).toBe(410)
})

test('anonymous browser cannot preflight, read Kernel evidence or export history', async ({ page }) => {
  const noPassword = await page.request.post(`${ORIGIN}/api/rr-operator/session`, { data: {password: 'obsolete'} })
  expect(noPassword.status()).toBe(410)
  const preflight = await page.request.post(`${ROUTE}/preflight`, { data: {} })
  expect(preflight.status()).toBe(401)
  const presentation = await page.request.get(`${ROUTE}/executions/not-allowed/presentation`)
  expect(presentation.status()).toBe(401)
  const history = await page.request.get(`${ROUTE}/decisions/not-allowed/history/export-complete`)
  expect(history.status()).toBe(401)
})

test('tampered isolated OIDC session never authorizes the Web BFF', async ({ page }) => {
  await installIsolatedOidcSession(page)
  const cookies = await page.context().cookies(ORIGIN)
  const session = cookies.find((cookie) => cookie.name === 'qdip_oidc_session')
  if (!session) throw new Error('Isolated browser session cookie missing')
  const last = session.value.slice(-1)
  await page.context().addCookies([{
    ...session,
    value: session.value.slice(0, -1) + (last === 'A' ? 'B' : 'A'),
  }])
  const denied = await page.request.get(`${ROUTE}/executions/denied/presentation`)
  expect(denied.status()).toBe(401)
  const status = await page.request.get(`${ORIGIN}/api/rr-operator/session`)
  expect(status.status()).toBe(200)
  expect(((await status.json()) as {authenticated: boolean}).authenticated).toBe(false)
})

test('live browser → Core preflight → CP-SAT → Mongo → decision-first → replan → verified export', async ({ page }) => {
  test.setTimeout(240_000)
  const original = actualInput()
  await installIsolatedOidcSession(page)
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
  const panel = page.getByTestId('rr-production-operator')
  await expect(panel).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Sign out' })).toBeVisible()

  const field = panel.getByLabel('Kernel execution JSON')
  await field.fill(JSON.stringify(original))
  await expect(page.getByTestId('rr-kernel-preflight')).toContainText(original.execution_id)
  await expect(page.getByRole('button', { name: 'Create execution', exact: true })).toBeEnabled()
  const createResponse = page.waitForResponse((r) =>
    r.url().endsWith('/api/rr-operator/kernel/executions') && r.request().method() === 'POST'
  )
  await panel.getByRole('button', { name: 'Create execution', exact: true }).click()
  const actualCreated = await createResponse
  expect(actualCreated.status()).toBe(201)
  const persisted = (await actualCreated.json()) as {actor_id: string; audit_evidence: {actor_id: string}}
  expect(persisted.actor_id).toMatch(/^zitadel:[a-f0-9]{64}$/)
  expect(persisted.audit_evidence.actor_id).toBe(persisted.actor_id)
  const summary = page.getByTestId('rr-decision-first')
  await expect(summary).toBeVisible()
  const evidence = summary.getByTestId('rr-kernel-evidence')
  await expect(evidence).toHaveAttribute('data-actionable', 'true')
  await expect(evidence).toContainText(original.source.snapshot_id)
  await expect(evidence).toContainText(original.execution_id)
  await expect(summary.getByTestId('rr-kernel-schedule').locator('tbody tr').first()).toBeVisible()
  await expect(panel.getByTestId('rr-technical-response')).toBeVisible()

  // Workspace presets alter only presentation; no new Kernel run or change in result.
  await panel.getByRole('button', { name: 'Business view' }).click()
  await expect(summary).toHaveAttribute('data-testid', 'rr-decision-first')
  await panel.getByRole('button', { name: 'Analyst view' }).click()
  await expect(summary).toBeVisible()

  const successorId = `${original.execution_id}-replanned`
  const later = new Date(Date.now() + 2000).toISOString()
  const changed = {
    execution_id: successorId,
    change_id: `change-${original.execution_id}`,
    kind: 'OVERRIDE',
    reason: 'Exclude the invented sensor-service job during isolated E2E testing.',
    requested_at: later,
    source: original.source,
    ingested_at: later,
    payload: {
      ...original.payload,
      operator_directives: { excluded_job_ids: ['sensor-service'] },
    },
  }
  await panel.getByLabel('Kernel replan JSON').fill(JSON.stringify(changed))
  const replanResponse = page.waitForResponse((r) =>
    r.url().endsWith(`/executions/${original.execution_id}/replan`) && r.request().method() === 'POST'
  )
  await panel.getByRole('button', { name: 'Replan from predecessor' }).click()
  const actualReplan = await replanResponse
  expect(actualReplan.status()).toBe(201)
  const persistedRevision = (await actualReplan.json()) as {actor_id: string; audit_evidence: {actor_id: string}}
  expect(persistedRevision.actor_id).toBe(persisted.actor_id)
  expect(persistedRevision.audit_evidence.actor_id).toBe(persisted.actor_id)
  await expect(summary).toBeVisible()
  await expect(summary.getByTestId('rr-kernel-evidence')).toContainText(successorId)
  await expect(summary.getByTestId('rr-kernel-schedule')).not.toContainText('sensor-service')

  const historyResponse = page.waitForResponse((r) =>
    r.url().endsWith(`/decisions/${original.payload.decision_id}/history`)
  )
  await panel.getByRole('button', { name: 'History', exact: true }).click()
  const history = await (await historyResponse).json() as { executions: unknown[] }
  expect(history.executions).toHaveLength(2)

  const replayResponse = page.waitForResponse((r) =>
    r.url().endsWith(`/executions/${successorId}/replay-verification`)
  )
  await panel.getByRole('button', { name: 'Replay' }).click()
  expect(((await (await replayResponse).json()) as { verified: boolean }).verified).toBe(true)

  // Verify the exact Core/Web route in use. The client assembles a complete
  // export from independently attested pages; it does not call export-complete.
  const verifiedPage = page.waitForResponse((r) =>
    r.url().includes(`/decisions/${original.payload.decision_id}/history/verified-export-page`)
  )
  const downloadPromise = page.waitForEvent('download')
  await panel.getByRole('button', { name: 'Export complete history' }).click()
  const verifiedResponse = await verifiedPage
  expect(verifiedResponse.status()).toBe(200)
  const attestation = (await verifiedResponse.json()) as {
    history_manifest_digest: string
    head_execution_id: string
    history_verified: boolean
  }
  expect(attestation.history_verified).toBe(true)
  expect(attestation.head_execution_id).toBe(successorId)
  expect(attestation.history_manifest_digest).toMatch(/^[a-f0-9]{64}$/)
  const downloaded = await downloadPromise
  expect(downloaded.suggestedFilename()).toBe(`rr-history-${original.payload.decision_id}.json`)
  const saved = await downloaded.path()
  if (!saved) throw new Error('Verified history download did not produce a local file')
  const exported = JSON.parse(readFileSync(saved, 'utf8')) as {
    head_execution_id: string
    history_manifest_digest: string
    history_verified: boolean
    export_complete: boolean
    executions: unknown[]
  }
  expect(exported.head_execution_id).toBe(successorId)
  expect(exported.history_manifest_digest).toBe(attestation.history_manifest_digest)
  expect(exported.history_verified).toBe(true)
  expect(exported.export_complete).toBe(true)
  expect(exported.executions).toHaveLength(2)

  await panel.getByRole('button', { name: 'Sign out' }).click()
  expect((await page.request.get(`${ROUTE}/executions/${successorId}/presentation`)).status()).toBe(401)
})

test('invalid input fails closed in real Core preflight; no fabricated decision appears', async ({ page }) => {
  actualInput()
  await installIsolatedOidcSession(page)
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
  const panel = page.getByTestId('rr-production-operator')
  await expect(panel.getByRole('button', { name: 'Sign out' })).toBeVisible()
  await panel.getByLabel('Kernel execution JSON').fill('{"execution_id":"invalid-input","source":{},"payload":{"jobs":[]}}')
  await expect(page.getByTestId('rr-kernel-preflight')).toContainText('Server preflight')
  await expect(panel.getByRole('button', { name: 'Create execution', exact: true })).toBeDisabled()
  await expect(page.getByTestId('rr-decision-first')).toHaveCount(0)
})
