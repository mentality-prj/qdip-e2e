/* Disposable HTTPS OIDC provider: exercises real Web PKCE/token/JWKS/userinfo.
 * Does not call, represent, or claim production Zitadel.
 */
import https from 'node:https'
import { readFileSync } from 'node:fs'
import { generateKeyPairSync, createHash, createSign, randomBytes } from 'node:crypto'

const issuer = 'https://identity.localhost:8443'
if (process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.ZITADEL_ISSUER !== issuer ||
    process.env.ZITADEL_QDIP_PROJECT_ID !== '123456789' ||
    process.env.ZITADEL_QDIP_ORGANIZATION_ID !== '987654321') {
  throw Error('Refuse non-disposable identity provider configuration')
}
const clientId = process.env.ZITADEL_CLIENT_ID
const origin = process.env.NEXT_PUBLIC_SITE_URL
const callback = origin + '/api/auth/callback/zitadel'
if (clientId !== 'qdip-e2e-client' || origin !== 'http://qdip.localhost:3000')
  throw Error('Unsafe local OIDC client or callback')
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const { privateKey: wrongKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const publicJwk = { ...publicKey.export({ format: 'jwk' }), kid: 'isolated-kid', alg: 'RS256', use: 'sig' }
const codes = new Map()
const accessTokens = new Map()
const roles = new Set(['operator', 'studio', 'none', 'wrong-org', 'userinfo', 'invalid-signature'])
const claimKey = 'urn:zitadel:iam:org:project:123456789:roles'

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}
function err(res) { send(res, 400, { error: 'invalid_request' }, { 'Content-Type': 'application/json' }) }
function grants(role) {
  const key = role === 'operator' || role === 'userinfo' ? 'rr_operator' : 'studio'
  if (role === 'none' || role === 'invalid-signature') return {}
  const org = role === 'wrong-org' ? '111111111' : '987654321'
  return { [claimKey]: { [key]: { [org]: 'identity.localhost' } } }
}
function signedJwt(claims, key) {
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'isolated-kid' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const data = head + '.' + body
  const signer = createSign('RSA-SHA256')
  signer.update(data)
  return data + '.' + signer.sign(key).toString('base64url')
}
function selectedRole(req) {
  const match = (req.headers.cookie || '').match(/(?:^|;\s*)mock_qdip_role=([a-z-]+)/)
  return match && roles.has(match[1]) ? match[1] : 'none'
}
const server = https.createServer({
  cert: readFileSync(process.env.MOCK_OIDC_CERT),
  key: readFileSync(process.env.MOCK_OIDC_KEY),
}, async (req, res) => {
  try {
    const url = new URL(req.url, issuer)
    if (req.method === 'GET' && url.pathname === '/health')
      return send(res, 200, 'ready')
    if (req.method === 'GET' && url.pathname === '/set-role') {
      const role = url.searchParams.get('role')
      if (!roles.has(role)) return err(res)
      return send(res, 200, 'test role selected', {
        'Set-Cookie': 'mock_qdip_role=' + role + '; Path=/; SameSite=Lax; Secure; HttpOnly',
        'Content-Type': 'text/plain',
      })
    }
    if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration')
      return send(res, 200, {
        issuer,
        authorization_endpoint: issuer + '/oauth/v2/authorize',
        token_endpoint: issuer + '/oauth/v2/token',
        jwks_uri: issuer + '/oauth/v2/keys',
        userinfo_endpoint: issuer + '/oidc/v1/userinfo',
      }, { 'Content-Type': 'application/json' })
    if (req.method === 'GET' && url.pathname === '/oauth/v2/keys')
      return send(res, 200, { keys: [publicJwk] }, { 'Content-Type': 'application/json' })
    if (req.method === 'GET' && url.pathname === '/oauth/v2/authorize') {
      const q = url.searchParams
      if (q.get('client_id') !== clientId || q.get('redirect_uri') !== callback ||
          q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' ||
          !/^[A-Za-z0-9_-]{20,100}$/.test(q.get('state') || '') ||
          !/^[A-Za-z0-9_-]{20,100}$/.test(q.get('nonce') || '') ||
          !/^[A-Za-z0-9_-]{43}$/.test(q.get('code_challenge') || '') ||
          !(q.get('scope') || '').includes('urn:zitadel:iam:org:projects:roles'))
        return err(res)
      const code = randomBytes(32).toString('base64url')
      codes.set(code, { role: selectedRole(req), challenge: q.get('code_challenge'), nonce: q.get('nonce') })
      const redirect = new URL(callback)
      redirect.searchParams.set('code', code)
      redirect.searchParams.set('state', q.get('state'))
      return send(res, 302, '', { Location: redirect.href })
    }
    if (req.method === 'POST' && url.pathname === '/oauth/v2/token') {
      let text = ''
      for await (const chunk of req) {
        text += chunk.toString('utf8')
        if (text.length > 10000) return err(res)
      }
      const q = new URLSearchParams(text)
      const code = q.get('code')
      const entry = codes.get(code)
      codes.delete(code)
      const check = createHash('sha256').update(q.get('code_verifier') || '').digest('base64url')
      if (!entry || q.get('grant_type') !== 'authorization_code' ||
          q.get('client_id') !== clientId || q.get('redirect_uri') !== callback ||
          check !== entry.challenge) return err(res)
      const now = Math.floor(Date.now() / 1000)
      const claims = {
        iss: issuer, aud: clientId, sub: 'isolated-oidc-test-account',
        nonce: entry.nonce, iat: now, exp: now + 900,
        ...(entry.role === 'userinfo' ? {} : grants(entry.role)),
      }
      const token = randomBytes(32).toString('base64url')
      accessTokens.set(token, entry.role)
      const jwtKey = entry.role === 'invalid-signature' ? wrongKey : privateKey
      return send(res, 200, {
        id_token: signedJwt(claims, jwtKey),
        access_token: token,
        token_type: 'Bearer', expires_in: 900,
      }, { 'Content-Type': 'application/json' })
    }
    if (req.method === 'GET' && url.pathname === '/oidc/v1/userinfo') {
      const bearer = (req.headers.authorization || '').match(/^Bearer ([A-Za-z0-9_-]+)$/)
      if (!bearer || !accessTokens.has(bearer[1])) return send(res, 401, '{}')
      return send(res, 200, {
        sub: 'isolated-oidc-test-account',
        ...grants(accessTokens.get(bearer[1])),
      }, { 'Content-Type': 'application/json' })
    }
    return send(res, 404, '{}')
  } catch {
    return err(res)
  }
})
server.listen(8443, '127.0.0.1', () => process.stdout.write('MOCK_OIDC_READY\n'))
