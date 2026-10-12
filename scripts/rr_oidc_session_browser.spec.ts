import { readFileSync } from 'node:fs'
import { createHmac } from 'node:crypto'
import { expect, test } from '@playwright/test'

// This spec is owned by the independent E2E suite and copied to the checked-out
// qdip-web/e2e directory ONLY when the rr-oidc-session-v1 contract is required.
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


type IsolatedRole = 'rr_operator' | 'studio'
type IsolatedClaims = {
  sub: string
  issuer: string
  clientId: string
  projectId: string
  organizationId: string
  expiresAt: number
  roles: IsolatedRole[]
}

/** Test-only signed session against real QDIP Web BFF; NOT a live Zitadel login. */
function makeIsolatedClaims(role: 'rr' | 'studio'): { secret: string; claims: IsolatedClaims } {
  const secret = process.env.QDIP_AUTH_COOKIE_SECRET ?? ''
  const issuer = process.env.ZITADEL_ISSUER ?? ''
  const clientId = process.env.ZITADEL_CLIENT_ID ?? ''
  const projectId = process.env.ZITADEL_QDIP_PROJECT_ID ?? ''
  const organizationId = process.env.ZITADEL_QDIP_ORGANIZATION_ID ?? ''
  const rrSubject = process.env.RR_E2E_OPERATOR_SUBJECT ?? ''
  const studioSubject = process.env.RR_E2E_STUDIO_SUBJECT ?? ''
  if (
    process.env.GITHUB_ACTIONS !== 'true' ||
    secret.length < 32 ||
    issuer !== 'https://qdip-e2e.invalid' ||
    clientId !== 'qdip-e2e-client' ||
    projectId !== '123456789' ||
    organizationId !== '987654321' ||
    process.env.QDIP_RR_ZITADEL_ROLE_KEY !== 'rr_operator' ||
    process.env.QDIP_STUDIO_ZITADEL_ROLE_KEY !== 'studio' ||
    rrSubject !== 'qdip-e2e-operator' ||
    studioSubject !== 'qdip-e2e-studio-only'
  ) throw new Error('Isolated OIDC test configuration incompatible with current Web contract')
  return {
    secret,
    claims: {
      sub: role === 'rr' ? rrSubject : studioSubject,
      issuer, clientId, projectId, organizationId,
      expiresAt: Math.floor(Date.now() / 1000) + 900,
      roles: [role === 'rr' ? 'rr_operator' : 'studio'],
    },
  }
}

async function installIsolatedOidcSession(
  page: import('@playwright/test').Page,
  role: 'rr' | 'studio' = 'rr',
  overrides: Partial<IsolatedClaims> = {}
) {
  const { secret, claims } = makeIsolatedClaims(role)
  const payload = Buffer.from(JSON.stringify({ ...claims, ...overrides })).toString('base64url')
  const signature = createHmac('sha256', secret).update('session-v1:' + payload).digest('base64url')
  await page.context().addCookies([{
    name: 'qdip_oidc_session',
    value: payload + '.' + signature,
    domain: 'observatory.localhost',
    path: '/',
    httpOnly: true,
    secure: false,
    sameSite: 'Lax',
    expires: Math.floor(Date.now() / 1000) + 900,
  }])
}

function actualInput(): CivilianRequest {
  if (process.env.RR_E2E_CONTRACT_MODE !== 'rr-oidc-session-v1')
    throw new Error('The real plugin browser suite requires rr-oidc-session-v1 mode')
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

// Only small predefined statuses/booleans are recorded; never persist a cookie,
// response body, subject, or production credential in public runner evidence.
function mark(label: string, value: number | boolean) {
  test.info().annotations.push({ type: 'rr-' + label, description: String(value) })
}

async function markOperatorSession(page: import('@playwright/test').Page) {
  const response = await page.request.get(`${ORIGIN}/api/rr-operator/session`)
  mark('session-http', response.status())
  if (response.status() === 200) {
    const value = (await response.json()) as { configured?: boolean; authenticated?: boolean }
    mark('session-configured', value.configured === true)
    mark('session-authenticated', value.authenticated === true)
  }
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
  const preflight = await page.request.post(`${ROUTE}/preflight`, { data: {} })
  const execution = await page.request.post(`${ROUTE}/executions`, { data: {} })
  const presentation = await page.request.get(`${ROUTE}/executions/not-allowed/presentation`)
  const history = await page.request.get(`${ROUTE}/decisions/not-allowed/history/export-complete`)
  mark('legacy-login-http', noPassword.status())
  mark('anonymous-preflight-http', preflight.status())
  mark('anonymous-presentation-http', presentation.status())
  mark('anonymous-history-http', history.status())
  await markOperatorSession(page)
  expect(noPassword.status()).toBe(410)
  expect(preflight.status()).toBe(401)
  expect(execution.status()).toBe(401)
  expect(presentation.status()).toBe(401)
  expect(history.status()).toBe(401)
})

test('isolated signed Studio-only role cannot access RR operator', async ({ page }) => {
  await installIsolatedOidcSession(page, 'studio')
  const globalSession = await page.request.get(`${ORIGIN}/api/auth/session`)
  expect(globalSession.status()).toBe(200)
  const identity = (await globalSession.json()) as { authenticated: boolean; studio: boolean; operator: boolean }
  expect(identity.authenticated).toBe(true)
  expect(identity.studio).toBe(true)
  expect(identity.operator).toBe(false)
  const operatorSession = await page.request.get(`${ORIGIN}/api/rr-operator/session`)
  expect(operatorSession.status()).toBe(200)
  expect(((await operatorSession.json()) as { authenticated: boolean }).authenticated).toBe(false)
  const denied = await page.request.post(`${ROUTE}/preflight`, { data: {} })
  expect(denied.status()).toBe(401)
  const write = await page.request.post(`${ROUTE}/executions`, { data: {} })
  expect(write.status()).toBe(401)
  const evidence = await page.request.get(`${ROUTE}/executions/not-allowed/presentation`)
  expect(evidence.status()).toBe(401)
})


test('signed RR role with wrong project, organization, issuer or expiry is denied', async ({ page }) => {
  const invalid: Partial<IsolatedClaims>[] = [
    { projectId: '123456788' },
    { organizationId: '987654320' },
    { issuer: 'https://other-e2e.invalid' },
    { expiresAt: Math.floor(Date.now() / 1000) - 10 },
    { expiresAt: Math.floor(Date.now() / 1000) + 7200 },
    { roles: [] },
    { roles: ['studio'] },
  ]
  for (const changed of invalid) {
    await installIsolatedOidcSession(page, 'rr', changed)
    const global = await page.request.get(`${ORIGIN}/api/auth/session`)
    expect(global.status()).toBe(200)
    const identity = (await global.json()) as { configured: boolean; authenticated: boolean; operator: boolean }
    expect(identity.configured).toBe(true)
    expect(identity.operator).toBe(false)
    expect(identity.authenticated).toBe(changed.roles?.[0] === 'studio')
    const rr = await page.request.get(`${ORIGIN}/api/rr-operator/session`)
    expect(rr.status()).toBe(200)
    expect(await rr.json()).toMatchObject({ configured: true, authenticated: false })
    const denied = await page.request.post(`${ROUTE}/preflight`, { data: {} })
    expect(denied.status()).toBe(401)
    const executeDenied = await page.request.post(`${ROUTE}/executions`, { data: {} })
    expect(executeDenied.status()).toBe(401)
  }
})

test('anonymous and Studio-only browser cannot operate RR', async ({ page }) => {
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
  const panel = page.getByTestId('rr-production-operator')
  await expect(panel).toBeVisible()
  const anonymous = await page.request.get(`${ORIGIN}/api/auth/session`)
  expect(anonymous.status()).toBe(200)
  expect(await anonymous.json()).toMatchObject({ configured: true, authenticated: false, operator: false })
  await expect(panel.getByRole('button', { name: 'Sign in with Zitadel' })).toBeVisible()
  await expect(panel.getByLabel('Kernel execution JSON')).toHaveCount(0)
  await expect(panel.getByRole('button', { name: 'Create execution' })).toHaveCount(0)
  await expect(page.getByTestId('rr-decision-first')).toHaveCount(0)
  await installIsolatedOidcSession(page, 'studio')
  const denied = await page.request.get(`${ORIGIN}/api/rr-operator/session`)
  expect(denied.status()).toBe(200)
  expect(await denied.json()).toMatchObject({ configured: true, authenticated: false })
  await page.reload()
  await expect(panel.getByRole('button', { name: 'Sign in with Zitadel' })).toBeVisible()
  await expect(panel.getByLabel('Kernel execution JSON')).toHaveCount(0)
  await expect(panel.getByRole('button', { name: 'Create execution' })).toHaveCount(0)
  await expect(page.getByTestId('rr-decision-first')).toHaveCount(0)
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
  mark('tampered-presentation-http', denied.status())
  await markOperatorSession(page)
  expect(denied.status()).toBe(401)
  const status = await page.request.get(`${ORIGIN}/api/rr-operator/session`)
  expect(status.status()).toBe(200)
  expect(((await status.json()) as {authenticated: boolean}).authenticated).toBe(false)
})

test('isolated signed-session browser → real Core → CP-SAT → Mongo → replan → verified export', async ({ page }) => {
  test.setTimeout(240_000)
  const original = actualInput()
  await installIsolatedOidcSession(page)
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
  await markOperatorSession(page)
  const globalSession = await page.request.get(`${ORIGIN}/api/auth/session`)
  expect(globalSession.status()).toBe(200)
  expect(await globalSession.json()).toMatchObject({
    configured: true, authenticated: true, operator: true, studio: false,
  })
  const operatorSession = await page.request.get(`${ORIGIN}/api/rr-operator/session`)
  expect(operatorSession.status()).toBe(200)
  expect(await operatorSession.json()).toMatchObject({
    configured: true, authenticated: true, mode: 'zitadel-oidc',
  })
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
  mark('execution-create-http', actualCreated.status())
  const originHeader = actualCreated.request().headers()['origin']
  mark('execution-create-origin-match', originHeader === ORIGIN)
  if (actualCreated.status() !== 201) {
    const body = (await actualCreated.json().catch(() => ({}))) as { error?: string; detail?: string }
    mark('execution-create-forbidden-origin', body.error === 'Forbidden origin')
    mark('execution-create-operator-unconfigured', body.error === 'RR operator mode is not configured')
    mark('execution-create-operator-unauthorized', body.error === 'RR operator login required')
    mark('execution-create-transport', body.error === 'TLS required')
    mark('execution-create-backend-unavailable', body.error === 'RR backend unavailable')
  }
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
  mark('replan-http', actualReplan.status())
  expect(actualReplan.status()).toBe(201)
  const persistedRevision = (await actualReplan.json()) as {actor_id: string; audit_evidence: {actor_id: string}}
  expect(persistedRevision.actor_id).toBe(persisted.actor_id)
  expect(persistedRevision.audit_evidence.actor_id).toBe(persisted.actor_id)
  await expect(summary).toBeVisible()
  await expect(summary.getByTestId('rr-kernel-evidence')).toContainText(successorId)
  await expect(summary.getByTestId('rr-kernel-schedule')).not.toContainText('sensor-service')
  mark('replan-presentation', true)

  const historyResponse = page.waitForResponse((r) =>
    r.url().endsWith(`/decisions/${original.payload.decision_id}/history`)
  )
  await panel.getByRole('button', { name: 'History', exact: true }).click()
  const actualHistory = await historyResponse
  mark('history-http', actualHistory.status())
  const history = await actualHistory.json() as { executions: unknown[] }
  mark('history-two-executions', Array.isArray(history.executions) && history.executions.length === 2)
  expect(history.executions).toHaveLength(2)

  const replayResponse = page.waitForResponse((r) =>
    r.url().endsWith(`/executions/${successorId}/replay-verification`)
  )
  await panel.getByRole('button', { name: 'Replay' }).click()
  const actualReplay = await replayResponse
  mark('replay-http', actualReplay.status())
  const replayValue = (await actualReplay.json()) as { verified: boolean }
  mark('replay-verified', replayValue.verified)
  expect(replayValue.verified).toBe(true)

  // Verify the exact Core/Web route in use. The client assembles a complete
  // export from independently attested pages; it does not call export-complete.
  const verifiedPage = page.waitForResponse((r) =>
    r.url().includes(`/decisions/${original.payload.decision_id}/history/verified-export-page`)
  )
  const downloadPromise = page.waitForEvent('download')
  await panel.getByRole('button', { name: 'Export complete history' }).click()
  const verifiedResponse = await verifiedPage
  mark('verified-export-page-http', verifiedResponse.status())
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
  mark('verified-history-downloaded', true)

  const logoutResponse = page.waitForResponse((r) =>
    r.url().endsWith('/api/auth/logout') && r.request().method() === 'POST'
  )
  await panel.getByRole('button', { name: 'Sign out' }).click()
  const logout = await logoutResponse
  mark('logout-http', logout.status())
  expect(logout.status()).toBe(200)
  await expect(panel.getByRole('button', { name: 'Sign out' })).not.toBeVisible()
  const afterLogout = await page.request.get(`${ROUTE}/executions/${successorId}/presentation`)
  mark('logout-revocation-http', afterLogout.status())
  expect(afterLogout.status()).toBe(401)
})

test('invalid input fails closed in real Core preflight; no fabricated decision appears', async ({ page }) => {
  actualInput()
  await installIsolatedOidcSession(page)
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
  await markOperatorSession(page)
  const panel = page.getByTestId('rr-production-operator')
  await expect(panel.getByRole('button', { name: 'Sign out' })).toBeVisible()
  await panel.getByLabel('Kernel execution JSON').fill('{"execution_id":"invalid-input","source":{},"payload":{"jobs":[]}}')
  await expect(page.getByTestId('rr-kernel-preflight')).toContainText('Server preflight')
  await expect(panel.getByRole('button', { name: 'Create execution', exact: true })).toBeDisabled()
  await expect(page.getByTestId('rr-decision-first')).toHaveCount(0)
})
