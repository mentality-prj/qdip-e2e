import { defineConfig, devices } from '@playwright/test'

// Real Web OIDC routing and cryptographic validation, with a fake local IdP.
// It does not use Web's pre-signed test storage state.
if (process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.ZITADEL_ISSUER !== 'https://identity.localhost:8443' ||
    !process.env.QDIP_AUTH_COOKIE_SECRET ||
    !process.env.NODE_EXTRA_CA_CERTS) {
  throw new Error('Isolated HTTPS OIDC test environment is required')
}

export default defineConfig({
  testDir: './e2e',
  timeout: 75_000,
  retries: 0,
  use: {
    baseURL: 'http://qdip.localhost:3000',
    storageState: { cookies: [], origins: [] },
    ignoreHTTPSErrors: true,
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm start --hostname 127.0.0.1',
    url: 'http://127.0.0.1:3000',
    reuseExistingServer: false,
    timeout: 120_000,
    env: Object.fromEntries([
      'NODE_EXTRA_CA_CERTS', 'ZITADEL_ISSUER', 'ZITADEL_CLIENT_ID',
      'QDIP_AUTH_COOKIE_SECRET', 'ZITADEL_QDIP_PROJECT_ID',
      'ZITADEL_QDIP_ORGANIZATION_ID', 'QDIP_RR_ZITADEL_ROLE_KEY',
      'QDIP_STUDIO_ZITADEL_ROLE_KEY',
      'NEXT_PUBLIC_SITE_URL', 'NEXT_PUBLIC_STUDIO_URL',
      'NEXT_PUBLIC_OBSERVATORY_URL',
    ].map((key) => [key, process.env[key] ?? ''])) as Record<string, string>,
  },
})
