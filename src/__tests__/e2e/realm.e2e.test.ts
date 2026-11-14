/**
 * pay-service in the realm, end to end, in one process (workspace ADR 0004).
 * Modelled on customers-service's `realm.e2e.test.ts`, whose harness it reuses:
 * customers is imported from its sources, not edited.
 *
 * ONE foldbase binary, and five real services built in-process: auth, iam, org,
 * customers and pay. A `fetch` router sends each service's base URL to its app,
 * so they call each other the way they do on a network: pay → customers,
 * pay → org, customers → org, and every service → auth's JWKS and
 * `/exchange-key`. The realm is ES256-only (no shared secret exists). Everything
 * is generated here: no `.env*` file is read, no running service or dev data is
 * touched.
 *
 * What is NOT driven: a browser sign-in. A person "signs in" by auth-service
 * being told the identity the way it tells iam after an OIDC callback, and the
 * session token is minted by auth-service's own mint function. From there every
 * step is a real HTTP route. The caches are off. The scenarios run in order and
 * share the world they build.
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FoldBase } from '../../../../foldbase/clients/ts/dist/index.js'
// @ts-expect-error — plain ESM helper, no types
import { bootServer, signJwt } from '../../../../foldbase/conformance/harness.mjs'
import { loadSigningKey, mint } from '@baseworks/auth/identity'
import { signHs256Jwt, parseJwtPayload } from '@baseworks/auth/jwt'
import { resetAuthExchange, resetAuthVerifier } from '@baseworks/auth/hono'
import { createApp as createAuth } from '../../../../auth-service/src/app.js'
import { mintIdentityToken } from '../../../../auth-service/src/lib/mint.js'
import { resetRealm } from '../../../../auth-service/src/lib/realm.js'
import { createApp as createIam, registerDefinitions as iamDefinitions } from '../../../../iam-service/src/app.js'
import { orgAccess as iamOrgAccess, registerWithOrg as iamRegister } from '../../../../iam-service/src/lib/org.js'
import { createApp as createOrg, registerDefinitions as orgDefinitions } from '../../../../org-service/src/app.js'
import { createApp as createCustomers, registerDefinitions as customersDefinitions } from '../../../../customers-service/src/app.js'
import { orgAccess as customersOrgAccess } from '../../../../customers-service/src/lib/org.js'
import { createApp as createPay, registerDefinitions as payDefinitions } from '../../app.js'
import { orgAccess as payOrgAccess } from '../../lib/org.js'

const here = dirname(fileURLToPath(import.meta.url))
const FB_SECRET = 'e2e-foldbase-secret-generated-in-test!'
const ISSUER = 'https://auth.e2e.test'
const AUDIENCE = 'e2e-realm'
const CLIENT_SECRETS = { 'auth-service': 's0-' + randomBytes(8).toString('hex'), customers: 's1-' + randomBytes(8).toString('hex'), pay: 's4-' + randomBytes(8).toString('hex'), stripe: 's5-' + randomBytes(8).toString('hex'), iam: 's2-' + randomBytes(8).toString('hex'), e2eapp: 's3-' + randomBytes(8).toString('hex') }

class Kv {
  private m = new Map<string, string>()
  async get(k: string) { return this.m.get(k) ?? null }
  async set(k: string, v: string) { this.m.set(k, v); return this }
  async del(k: string) { this.m.delete(k); return this }
}

// ── the world ─────────────────────────────────────────────────────────────────

type Seen = { host: string; method: string; path: string; authorization: string; body: string }
const traffic: Seen[] = []
/** Authorization headers carrying an API token that a service sent ONTO another service (never the first hop). */
const bwtOnward: Seen[] = []
let inFlight = 0
const savedEnv = { ...process.env }
const realFetch = globalThis.fetch

let fbStop: () => Promise<void>
let fbBase = ''
let svcToken = ''
let apps: Record<string, { fetch: (r: Request) => Response | Promise<Response> }>
const rawFor = (tenant: string) => new FoldBase({ baseUrl: fbBase, token: svcToken, tenant }).withAuth({ uid: 'e2e', role: 'admin' })

const router = (async (input: string | URL | Request, init?: RequestInit) => {
  const req = new Request(input as never, init)
  const host = new URL(req.url).hostname
  const app = apps?.[host]
  if (!app) return realFetch(input as never, init)
  const body = ['GET', 'HEAD'].includes(req.method) ? '' : await req.clone().text()
  const seen = { host, method: req.method, path: new URL(req.url).pathname, authorization: req.headers.get('authorization') ?? '', body }
  traffic.push(seen)
  // the first hop of a test's request is the outermost router call; anything inside it is one service calling another
  if (inFlight > 0 && seen.authorization.startsWith('Bearer bwt_')) bwtOnward.push(seen)
  inFlight++
  try { return await app.fetch(req) } finally { inFlight-- }
}) as typeof fetch

interface Res { status: number; body: Record<string, any>; text: string }
async function call(host: string, method: string, path: string, o: { token?: string; body?: unknown; org?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (o.token) headers['authorization'] = `Bearer ${o.token}`
  if (o.org) headers['x-org-id'] = o.org
  const res = await router(`http://${host}${path}`, { method, headers, ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }) })
  const text = await res.text()
  let body: Record<string, any> = {}
  try { body = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, body, text }
}
const auth = (m: string, p: string, o?: Parameters<typeof call>[3]) => call('auth.test', m, `/api${p}`, o)
const iam = (m: string, p: string, o?: Parameters<typeof call>[3]) => call('iam.test', m, `/api${p}`, o)
const org = (m: string, p: string, o?: Parameters<typeof call>[3]) => call('org.test', m, `/api${p}`, o)
const cust = (m: string, p: string, o?: Parameters<typeof call>[3]) => call('customers.test', m, `/api${p}`, o)
const pay = (m: string, p: string, o?: Parameters<typeof call>[3]) => call('pay.test', m, `/api${p}`, o)

const decode = (jwt: string) => parseJwtPayload(jwt) as Record<string, any>
const bearerOf = (s: Seen) => s.authorization.replace(/^Bearer /, '')
async function eventually<T>(fn: () => Promise<T | false | undefined | null>, ms = 5000): Promise<T> {
  const until = Date.now() + ms
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > until) throw new Error('eventually: gave up'); await new Promise((r) => setTimeout(r, 25)) }
}

interface Person { id: string; handle: string; email: string; session: string }
async function signIn(name: string): Promise<Person> {
  // What auth-service does after an OIDC callback: tell iam who this is, as itself.
  const svc = await auth('POST', '/service-token', { body: { client_id: 'auth-service', client_secret: CLIENT_SECRETS['auth-service'] } })
  expect(svc.status).toBe(200)
  const synced = await call('iam.test', 'POST', '/_/sync', { token: svc.body['token'], body: { subject: `sub-${name}`, issuer: 'https://idp.e2e.test', email: `${name}@e2e.test`, name } })
  expect(synced.status).toBe(200)
  const id = synced.body['user'].id as string
  const session = (await mintIdentityToken({ sub: id, type: 'human', expires_in_seconds: 3600 }))!
  const me = await iam('GET', '/me', { token: session })
  return { id, handle: me.body['user'].handle, email: `${name}@e2e.test`, session }
}

const P = {} as Record<'ada' | 'bob' | 'carol' | 'dan' | 'eve', Person>
let A = { id: '', slug: 'acme', short_id: '' }
let B = { id: '', slug: 'globex', short_id: '' }

beforeAll(async () => {
  // The realm: an ES256 key made here, a realm with no shared secret.
  const pemKey = () => generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  Object.assign(process.env, {
    AUTH_SIGNING_KEY: Buffer.from(pemKey()).toString('base64'),
    AUTH_ISSUER: ISSUER, AUTH_AUDIENCE: AUDIENCE, APP_PUBLIC_URL: ISSUER,
    AUTH_SERVICE_CLIENTS: Object.entries(CLIENT_SECRETS).map(([k, v]) => `${k}:${v}`).join(','),
    AUTH_JWKS_URI: 'http://auth.test/api/.well-known/jwks.json', AUTH_URL: 'http://auth.test/api',
    IAM_SERVICE_URL: 'http://iam.test', ORG_SERVICE_URL: 'http://org.test',
    ORG_ROLE_CACHE_SECONDS: '0', CUSTOMERS_PERMISSION_CACHE_SECONDS: '0', PAY_PERMISSION_CACHE_SECONDS: '0', PAY_SERVICE_CLIENT_SECRET: CLIENT_SECRETS.pay, AUTH_EXCHANGE_CACHE: 'off',
    IAM_VERIFY_CALLERS: 'auth-service', CUSTOMERS_SERVICE_CLIENT_SECRET: CLIENT_SECRETS.customers, IAM_SERVICE_CLIENT_SECRET: CLIENT_SECRETS.iam,
  })
  delete process.env['JWT_SECRET']
  delete process.env['IAM_ORG_TOKEN_ISSUERS']
  delete process.env['ORG_MEMBERSHIP_WRITERS']
  resetRealm(); resetAuthVerifier(); resetAuthExchange()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.stubGlobal('fetch', router)

  const es = await bootServer({ cmd: './bin/foldbase', dir: resolve(here, '../../../../foldbase/go'), env: { FOLDBASE_AUTH: 'service-jwt', FOLDBASE_JWT_SECRET: FB_SECRET } })
  fbBase = es.base; fbStop = es.stop
  svcToken = signJwt({ sub: 'e2e-services', type: 'service' }, FB_SECRET)
  const fbFor = (tenant: string) => new FoldBase({ baseUrl: fbBase, token: svcToken, tenant })

  const iamFb = fbFor('iam'); await iamDefinitions(iamFb)
  const orgFb = fbFor('org'); await orgDefinitions(orgFb)
  const custFb = fbFor('customers'); await customersDefinitions(custFb)
  const payFb = fbFor('pay'); await payDefinitions(payFb)

  const iamOrg = iamOrgAccess(process.env, router)!
  const custOrg = customersOrgAccess('http://org.test', process.env, router)
  const payOrg = payOrgAccess('http://org.test', process.env, router)
  apps = {
    'auth.test': createAuth({ kv: new Kv() as never }),
    'iam.test': createIam(iamFb, { org: iamOrg }),
    'org.test': createOrg(orgFb),
    'customers.test': createCustomers(custFb, 'http://org.test', { org: custOrg }),
    'pay.test': createPay(payFb, 'http://org.test', 'http://customers.test', { org: payOrg }),
  }
  ;(globalThis as Record<string, unknown>)['__e2e'] = { iamOrg, custOrg, payOrg }
}, 60_000)

afterAll(async () => {
  vi.unstubAllGlobals(); vi.restoreAllMocks()
  process.env = { ...savedEnv }
  resetRealm(); resetAuthVerifier(); resetAuthExchange()
  await fbStop?.()
})

const handlers = () => (globalThis as Record<string, any>)['__e2e'] as { iamOrg: { register(): Promise<void> }; custOrg: { register(): Promise<void> }; payOrg: { register(): Promise<void> } }

// ── 1 ─────────────────────────────────────────────────────────────────────────

let customer = { id: '', short_id: '' }
describe('1. boot: a member is refused until pay has registered its actions, and allowed after', () => {
  it('refused, registered with a service token auth-service issued, allowed', async () => {
    for (const n of ['ada', 'bob', 'carol', 'dan', 'eve'] as const) P[n] = await signIn(n)
    const a = await org('POST', '/orgs', { token: P.ada.session, body: { name: 'Acme', slug: 'acme' } })
    expect(a.status).toBe(201)
    A = { id: a.body['org'].id, slug: 'acme', short_id: a.body['org'].short_id }
    const b = await org('POST', '/orgs', { token: P.eve.session, body: { name: 'Globex', slug: 'globex' } })
    B = { id: b.body['org'].id, slug: 'globex', short_id: b.body['org'].short_id }
    for (const [who, role] of [['bob', 'member'], ['carol', 'viewer'], ['dan', 'admin']] as const) {
      expect((await org('POST', '/orgs/acme/members', { token: P.ada.session, body: { user_id: P[who].id, role } })).status).toBe(201)
    }
    expect((await org('POST', '/orgs/globex/members', { token: P.eve.session, body: { user_id: P.bob.id, role: 'member' } })).status).toBe(201)

    // customers and iam register; pay has not yet
    await handlers().custOrg.register()
    await handlers().iamOrg.register()
    const before = await pay('GET', '/payments', { token: P.bob.session, org: 'acme' })
    expect(before.status).toBe(403)
    expect(before.body).toMatchObject({ error: 'forbidden', permission: 'payment.read' })
    expect((await pay('GET', '/payments', { token: P.ada.session, org: 'acme' })).status).toBe(403)

    await handlers().payOrg.register()
    const apps = (await org('GET', '/apps', { token: P.ada.session })).body['apps'] as Array<{ name: string }>
    expect(apps.map((x) => x.name)).toContain('pay')
    expect((await rawFor('org').readAll({ limit: 10_000 })).some((e) => e.type === 'AppRegistered' && e.actor === 'service:pay')).toBe(true)
    const after = await pay('GET', '/payments', { token: P.bob.session, org: 'acme' })
    expect(after.status).toBe(200)
    expect(after.body).toEqual({ payments: [] })

    // a customer to charge, made through customers-service by a person
    const made = await cust('POST', '/customers', { token: P.ada.session, org: 'acme', body: { name: 'Acme Ltd' } })
    expect(made.status).toBe(201)
    customer = { id: made.body['customer'].id, short_id: made.body['customer'].short_id }
  })
})

// ── 2 ─────────────────────────────────────────────────────────────────────────

const charge = (key: string, extra: Record<string, unknown> = {}) => ({ customer_id: customer.short_id, amount_cents: 2500, currency: 'EUR', idempotency_key: key, ...extra })
const payments = async (tenant: string) => (await rawFor(tenant).query('payments', {})).rows

describe('2. a person\'s session charges; another organization sees none of it', () => {
  it('the customer is resolved through customers-service, the charge is snake_case, stored in the org\'s tenant and idempotent', async () => {
    traffic.length = 0
    const made = await pay('POST', '/payments', { token: P.bob.session, org: 'acme', body: charge('e2e-1') })
    expect(made.status).toBe(201)
    expect(made.body['payment']).toMatchObject({ customer_id: customer.id, customer_name: 'Acme Ltd', amount_cents: 2500, currency: 'EUR', provider: 'manual', status: 'succeeded' })
    expect(Object.keys(made.body['payment']).filter((k) => /[A-Z]/.test(k))).toEqual([])
    // pay asked customers with the realm token this request ran on, for the org's id
    const toCustomers = traffic.filter((t) => t.host === 'customers.test')
    expect(toCustomers.length).toBeGreaterThanOrEqual(1)
    expect(toCustomers[0]!.authorization).toBe(`Bearer ${P.bob.session}`)

    const again = await pay('POST', '/payments', { token: P.bob.session, org: 'acme', body: charge('e2e-1') })
    expect(again.body['payment']['id']).toBe(made.body['payment']['id'])
    expect(await payments(A.id)).toHaveLength(1)
    expect(await payments(B.id)).toHaveLength(0)

    // eve is in the other organization: not a member of acme, and sees none of its payments in her own
    expect((await pay('GET', '/payments', { token: P.eve.session, org: 'acme' })).status).toBe(403)
    expect((await pay('GET', '/payments', { token: P.eve.session, org: 'globex' })).body).toEqual({ payments: [] })
    // carol is a viewer: reads, and cannot charge
    expect((await pay('GET', '/payments', { token: P.carol.session, org: 'acme' })).body['payments']).toHaveLength(1)
    const refused = await pay('POST', '/payments', { token: P.carol.session, org: 'acme', body: charge('e2e-viewer') })
    expect(refused.status).toBe(403)
    expect(refused.body).toMatchObject({ error: 'forbidden', permission: 'payment.charge' })
    expect(await payments(A.id)).toHaveLength(1)
  })
})

// ── 3 ─────────────────────────────────────────────────────────────────────────

describe('3. a read-only personal API token', () => {
  it('reads, is refused a charge (permission named), and nothing is stored', async () => {
    const issued = await iam('POST', '/tokens', { token: P.bob.session, body: { name: 'ro', type: 'user', scopes: ['read'] } })
    expect(issued.status).toBe(201)
    const secret = issued.body['secret'] as string
    expect(secret).toMatch(/^bwt_/)

    const read = await pay('GET', '/payments', { token: secret, org: 'acme' })
    expect(read.status).toBe(200)
    expect(read.body['payments']).toHaveLength(1)
    const write = await pay('POST', '/payments', { token: secret, org: 'acme', body: charge('e2e-ro') })
    expect(write.status).toBe(403)
    expect(write.body).toMatchObject({ error: 'forbidden', permission: 'payment.charge' })
    expect(await payments(A.id)).toHaveLength(1)
    // a refusal is not a revocation
    expect((await pay('GET', '/payments', { token: secret, org: 'acme' })).status).toBe(200)
  })
})

// ── 4 ─────────────────────────────────────────────────────────────────────────

describe('4. a write personal API token', () => {
  it('charges; what reached org-service and customers-service was the exchanged JWT, never the bwt_', async () => {
    const issued = await iam('POST', '/tokens', { token: P.bob.session, body: { name: 'rw', type: 'user', scopes: ['read', 'write'] } })
    const secret = issued.body['secret'] as string
    const tokenId = issued.body['token'].id as string
    traffic.length = 0; bwtOnward.length = 0
    const made = await pay('POST', '/payments', { token: secret, org: 'acme', body: charge('e2e-rw') })
    expect(made.status).toBe(201)
    expect(await payments(A.id)).toHaveLength(2)

    // pay received the API token, and it went to auth once to be exchanged…
    expect(traffic.find((t) => t.host === 'pay.test')!.authorization).toBe(`Bearer ${secret}`)
    const exchanges = traffic.filter((t) => t.host === 'auth.test' && t.path === '/api/exchange-key')
    expect(exchanges.length).toBeGreaterThanOrEqual(1)
    expect(JSON.parse(exchanges[0]!.body).token).toBe(secret)
    // …and everything pay sent on carried the realm token
    const onward = traffic.filter((t) => t.host === 'org.test' || t.host === 'customers.test')
    expect(onward.filter((t) => t.host === 'customers.test').length).toBeGreaterThanOrEqual(1)
    expect(onward.filter((t) => t.host === 'org.test').length).toBeGreaterThanOrEqual(2)
    for (const t of onward) {
      expect(t.authorization, `${t.host} ${t.method} ${t.path}`).not.toContain('bwt_')
      expect(t.authorization.split('.')).toHaveLength(3)
    }
    expect(decode(bearerOf(onward[0]!))).toMatchObject({ sub: P.bob.id, kind: 'human', via: 'token', credential_id: tokenId, access: ['read', 'write'], iss: ISSUER, aud: AUDIENCE })
    expect(bwtOnward.filter((t) => t.host === 'org.test' || t.host === 'customers.test' || t.host === 'pay.test')).toEqual([])
    const leaks = traffic.filter((t) => (t.authorization + t.body).includes(secret) && !(t.host === 'pay.test' || (t.host === 'auth.test' && t.path === '/api/exchange-key') || (t.host === 'iam.test' && t.path === '/_/tokens/verify')))
    expect(leaks).toEqual([])
  })
})

// ── 5 ─────────────────────────────────────────────────────────────────────────

let agent = { id: '', secret: '', tokenId: '' }
describe('5. an agent', () => {
  it('is made by the person, charges for them, and cannot forge a provider\'s outcome', async () => {
    const created = await iam('POST', '/agents', { token: P.bob.session, body: { name: 'dev' } })
    expect(created.status).toBe(201)
    agent.id = created.body['agent'].id
    const issued = await iam('POST', `/agents/${agent.id}/tokens`, { token: P.bob.session, body: { name: 'laptop', access: 'write', org_id: A.id } })
    agent.secret = issued.body['secret']; agent.tokenId = issued.body['token'].id

    const made = await pay('POST', '/payments', { token: agent.secret, org: 'acme', body: charge('e2e-agent') })
    expect(made.status).toBe(201)
    expect(await payments(A.id)).toHaveLength(3)

    // the outcome fields are a service's alone
    const forged = await pay('POST', '/payments', { token: agent.secret, org: 'acme', body: charge('e2e-forged', { provider: 'stripe', status: 'succeeded', provider_ref: 'pi_x' }) })
    expect(forged.status).toBe(403)
    const forgedByPerson = await pay('POST', '/payments', { token: P.bob.session, org: 'acme', body: charge('e2e-forged', { provider: 'stripe', status: 'succeeded', provider_ref: 'pi_x' }) })
    expect(forgedByPerson.status).toBe(403)
    expect(await payments(A.id)).toHaveLength(3)

    // bound to its organization
    for (const ref of [B.slug, B.id, B.short_id]) expect((await pay('GET', '/payments', { token: agent.secret, org: ref })).status, ref).toBe(403)
    // and gone with the owner's membership, and back with it
    expect((await org('DELETE', `/orgs/acme/members/${P.bob.id}`, { token: P.ada.session })).status).toBe(200)
    expect((await pay('POST', '/payments', { token: agent.secret, org: 'acme', body: charge('e2e-ghost') })).status).toBe(403)
    expect(await payments(A.id)).toHaveLength(3)
    expect((await org('POST', '/orgs/acme/members', { token: P.ada.session, body: { user_id: P.bob.id, role: 'member' } })).status).toBe(201)
    expect((await pay('GET', '/payments', { token: agent.secret, org: 'acme' })).status).toBe(200)
  })
})

// ── 6 ─────────────────────────────────────────────────────────────────────────

describe('6. an organization key', () => {
  it('a read key reads and cannot charge; a write key charges', async () => {
    const ro = await iam('POST', '/orgs/acme/keys', { token: P.dan.session, body: { name: 'ci-read', role: 'member', access: 'read' } })
    expect(ro.status).toBe(201)
    expect((await pay('GET', '/payments', { token: ro.body['secret'], org: 'acme' })).status).toBe(200)
    const refused = await pay('POST', '/payments', { token: ro.body['secret'], org: 'acme', body: charge('e2e-key-ro') })
    expect(refused.status).toBe(403)
    expect(refused.body).toMatchObject({ permission: 'payment.charge' })
    expect((await pay('GET', '/payments', { token: ro.body['secret'], org: 'globex' })).status).toBe(403)
    expect(await payments(A.id)).toHaveLength(3)

    const rw = await iam('POST', '/orgs/acme/keys', { token: P.dan.session, body: { name: 'ci-write', role: 'member', access: 'write' } })
    expect((await pay('POST', '/payments', { token: rw.body['secret'], org: 'acme', body: charge('e2e-key-rw') })).status).toBe(201)
    expect(await payments(A.id)).toHaveLength(4)
  })
})

// ── 7 ─────────────────────────────────────────────────────────────────────────

describe('7. a service records what its provider did', () => {
  it('stripe, with its own service token, may set the outcome; the payment says service:stripe', async () => {
    const svc = await auth('POST', '/service-token', { body: { client_id: 'stripe', client_secret: CLIENT_SECRETS.stripe } })
    expect(svc.status).toBe(200)
    const res = await pay('POST', '/payments', { token: svc.body['token'], org: A.id, body: charge('evt_e2e_1', { provider: 'stripe', status: 'failed', provider_ref: 'pi_e2e', failure_reason: 'insufficient_funds' }) })
    expect(res.status).toBe(201)
    expect(res.body['payment']).toMatchObject({ provider: 'stripe', status: 'failed', provider_ref: 'pi_e2e', failure_reason: 'insufficient_funds' })
    expect((await pay('GET', '/payments/evt_e2e_1', { token: P.bob.session, org: 'acme' })).body['payment']['id']).toBe(res.body['payment']['id'])
  })
})

// ── 8 ─────────────────────────────────────────────────────────────────────────

describe('8. who the events say wrote them', () => {
  it('the actor and the audit envelope of each payment: a person, the same person by token, an agent, a machine, a service', async () => {
    type Ev = { type: string; actor: string; correlationId?: string; payload: { idempotency_key: string }; metadata?: { audit?: Record<string, unknown> } }
    const events = (await rawFor(A.id).readAll({ limit: 10_000 })) as unknown as Ev[]
    const by = (key: string) => events.find((e) => e.type === 'PaymentCharged' && e.payload.idempotency_key === key)!
    const audit = (key: string) => by(key).metadata!.audit!
    expect(by('e2e-1').actor).toBe(`user:${P.bob.id}`)
    expect(audit('e2e-1')).toMatchObject({ kind: 'human', actor: `user:${P.bob.id}`, via: 'session', org_id: A.id })
    expect(by('e2e-rw').actor).toBe(`user:${P.bob.id}`)
    expect(audit('e2e-rw')).toMatchObject({ kind: 'human', via: 'token', org_id: A.id })
    expect(by('e2e-agent').actor).toBe(`agent:dev@${P.bob.handle}`)
    expect(audit('e2e-agent')).toMatchObject({ kind: 'agent', actor: `agent:dev@${P.bob.handle}`, on_behalf_of: `user:${P.bob.id}`, via: 'token', credential_id: agent.tokenId, org_id: A.id })
    expect(by('e2e-key-rw').actor).toMatch(new RegExp(`^machine:.+@${A.id}$`))
    expect(audit('e2e-key-rw')).toMatchObject({ kind: 'machine', via: 'key', org_id: A.id })
    expect(by('evt_e2e_1').actor).toBe('service:stripe')
    expect(audit('evt_e2e_1')).toMatchObject({ kind: 'service', actor: 'service:stripe', org_id: A.id })
    // every one of them carries the id of its own request
    for (const k of ['e2e-1', 'e2e-rw', 'e2e-agent', 'e2e-key-rw', 'evt_e2e_1']) {
      expect(by(k).correlationId).toBe(audit(k)['request_id'])
      expect(Object.keys(by(k)).includes('payload') && Object.keys(by(k).payload).filter((x) => /[A-Z]/.test(x))).toEqual([])
    }
  })
})
