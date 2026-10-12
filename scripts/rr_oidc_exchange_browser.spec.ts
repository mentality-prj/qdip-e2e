import { test, expect } from '@playwright/test'

const site = 'http://qdip.localhost:3000'
const fakeIssuer = 'https://identity.localhost:8443'

// Browser must follow the actual site's login redirect, local TLS identity
// provider authorization, PKCE code exchange, token verification and callback.
// These tests never inject or sign application session cookies directly.
async function signIn(page: import('@playwright/test').Page, role: string) {
  const selected = await page.goto(fakeIssuer + '/set-role?role=' + role)
  expect(selected?.status()).toBe(200)
  return page.goto(site + '/api/auth/login?return_to=' + encodeURIComponent(site + '/en'), {
    waitUntil: 'domcontentloaded',
  })
}
async function session(page: import('@playwright/test').Page) {
  const response = await page.request.get(site + '/api/auth/session')
  expect(response.status()).toBe(200)
  return response.json() as Promise<{
    configured: boolean; authenticated: boolean; studio: boolean; operator: boolean
  }>
}

test('full OIDC code+PKCE+JWKS login grants verified RR role', async ({ page }) => {
  await signIn(page, 'operator')
  await expect(page).toHaveURL(site + '/en')
  expect(await session(page)).toMatchObject({
    configured: true, authenticated: true, studio: false, operator: true,
  })
})
test('full OIDC login grants only Studio role and never RR role', async ({ page }) => {
  await signIn(page, 'studio')
  await expect(page).toHaveURL(site + '/en')
  expect(await session(page)).toMatchObject({
    configured: true, authenticated: true, studio: true, operator: false,
  })
})
test('roleless OIDC account is denied by callback and has no session', async ({ page }) => {
  const callback = await signIn(page, 'none')
  expect(callback?.status()).toBe(403)
  await expect(page.getByRole('heading', { name: 'QDIP access is not assigned' })).toBeVisible()
  expect(await session(page)).toMatchObject({ authenticated: false, studio: false, operator: false })
})
test('project role grant from wrong organization is denied', async ({ page }) => {
  const callback = await signIn(page, 'wrong-org')
  expect(callback?.status()).toBe(403)
  expect(await session(page)).toMatchObject({ authenticated: false, operator: false })
})
test('OIDC callback can derive RR role from verified Userinfo fallback', async ({ page }) => {
  await signIn(page, 'userinfo')
  await expect(page).toHaveURL(site + '/en')
  expect(await session(page)).toMatchObject({ authenticated: true, operator: true })
})
test('invalid RS256 ID-token signature is rejected before creating a session', async ({ page }) => {
  const callback = await signIn(page, 'invalid-signature')
  expect(callback?.status()).toBe(401)
  await expect(page.getByRole('heading', { name: 'Sign-in could not be verified' })).toBeVisible()
  expect(await session(page)).toMatchObject({ authenticated: false, operator: false })
})
