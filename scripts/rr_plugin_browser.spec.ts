import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

// This spec is owned by the independent E2E suite and copied to the checked-out
// qdip-web/e2e directory ONLY when the rr-plugin-v1 contract is required.
// Never mock HTTP, cookies, the Kernel, persistence, or browser authentication.
const ORIGIN = 'http://observatory.localhost:3000'
const PAGE = `${ORIGIN}/en/readiness-recovery`
const ROUTE = `${ORIGIN}/api/rr-operator/kernel`

type CivilianRequest = {
  execution_id: string
  source: { source_system: string; snapshot_id: string; source_version: string; captured_at: string }
  ingested_at: string
  payload: { decision_id: string; operator_directives?: { excluded_job_ids: string[] } }
}

function actualInput(): CivilianRequest {
  if (process.env.RR_E2E_CONTRACT_MODE !== 'rr-plugin-v1')
    throw new Error('The real plugin browser suite requires rr-plugin-v1 mode')
  const path = process.env.RR_E2E_API_REQUEST_PATH
  if (!path || !process.env.RR_E2E_OPERATOR_PASSWORD)
    throw new Error('Real RR plugin E2E credentials and disposable input are required')
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
  const preflight = await page.request.post(`${ROUTE}/preflight`, { data: {} })
  expect(preflight.status()).toBe(401)
  const presentation = await page.request.get(`${ROUTE}/executions/not-allowed/presentation`)
  expect(presentation.status()).toBe(401)
  const history = await page.request.get(`${ROUTE}/decisions/not-allowed/history/export-complete`)
  expect(history.status()).toBe(401)
})

test('live browser → Core preflight → CP-SAT → Mongo → decision-first → replan → verified export', async ({ page }) => {
  test.setTimeout(240_000)
  const original = actualInput()
  const password = process.env.RR_E2E_OPERATOR_PASSWORD!
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
  const panel = page.getByTestId('rr-production-operator')
  await expect(panel).toBeVisible()
  await panel.getByLabel('Operator access password').fill(password)
  await panel.getByRole('button', { name: 'Unlock reference operator' }).click()
  await expect(panel.getByRole('button', { name: 'Sign out' })).toBeVisible()

  const field = panel.getByLabel('Kernel execution JSON')
  await field.fill(JSON.stringify(original))
  await expect(page.getByTestId('rr-kernel-preflight')).toContainText(original.execution_id)
  await expect(page.getByRole('button', { name: 'Create execution', exact: true })).toBeEnabled()
  const createResponse = page.waitForResponse((r) =>
    r.url().endsWith('/api/rr-operator/kernel/executions') && r.request().method() === 'POST'
  )
  await panel.getByRole('button', { name: 'Create execution', exact: true }).click()
  expect((await createResponse).status()).toBe(201)
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
  expect((await replanResponse).status()).toBe(201)
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

  const downloadPromise = page.waitForEvent('download')
  await panel.getByRole('button', { name: 'Export complete history' }).click()
  const downloaded = await downloadPromise
  expect(downloaded.suggestedFilename()).toBe(`rr-history-${original.payload.decision_id}.json`)
  const saved = await downloaded.path()
  if (!saved) throw new Error('Verified history download did not produce a local file')
  const exported = JSON.parse(readFileSync(saved, 'utf8')) as {
    head_execution_id: string
    history_verified: boolean
    export_complete: boolean
    executions: unknown[]
  }
  expect(exported.head_execution_id).toBe(successorId)
  expect(exported.history_verified).toBe(true)
  expect(exported.export_complete).toBe(true)
  expect(exported.executions).toHaveLength(2)

  await panel.getByRole('button', { name: 'Sign out' }).click()
  expect((await page.request.get(`${ROUTE}/executions/${successorId}/presentation`)).status()).toBe(401)
})

test('invalid input fails closed in real Core preflight; no fabricated decision appears', async ({ page }) => {
  actualInput()
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' })
  const panel = page.getByTestId('rr-production-operator')
  await panel.getByLabel('Operator access password').fill(process.env.RR_E2E_OPERATOR_PASSWORD!)
  await panel.getByRole('button', { name: 'Unlock reference operator' }).click()
  await expect(panel.getByRole('button', { name: 'Sign out' })).toBeVisible()
  await panel.getByLabel('Kernel execution JSON').fill('{"execution_id":"invalid-input","source":{},"payload":{"jobs":[]}}')
  await expect(page.getByTestId('rr-kernel-preflight')).toContainText('Server preflight')
  await expect(panel.getByRole('button', { name: 'Create execution', exact: true })).toBeDisabled()
  await expect(page.getByTestId('rr-decision-first')).toHaveCount(0)
})
