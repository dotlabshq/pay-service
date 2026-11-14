/**
 * Workspace ADR 0004: who may charge, and who caused it. A charge is the one
 * write route. For each kind of principal that can reach it (a signed-in
 * person, the same person by API token, an agent, an organization's key, a
 * service) the answer is asserted, and where it is yes the stored event is
 * read back raw and its `actor` and whole `metadata.audit` are checked. A
 * credential that may not write, or belongs to another organization, writes
 * nothing.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FoldBase } from '@baseworks/foldbase'
import { signHs256Jwt } from '@baseworks/auth/jwt'
import { JWT_SECRET, bootTestFoldBase, fakeOrgService, makeServiceToken, makeTestApp, makeToken, newOrgId, type TestFoldBase } from './setup.js'

type App = Awaited<ReturnType<typeof makeTestApp>>
type Ev = { type: string; actor?: string; payload: Record<string, any>; metadata?: { audit?: Record<string, unknown> }; correlationId?: string }

let fb: TestFoldBase
let app: App
let orgId: string
let other: string
let restoreOrg: ReturnType<typeof fakeOrgService>
let reqN = 0
let keyN = 0
const USER = 'u-ada'
const CUSTOMERS = { 'cus-1': { id: 'cus-1', name: 'Acme Ltd' } }

beforeAll(async () => { fb = await bootTestFoldBase() }, 30_000)
afterAll(async () => { await fb.stop() })
beforeEach(async () => {
  orgId = newOrgId(); other = newOrgId()
  app = await makeTestApp(fb, orgId)
  restoreOrg = fakeOrgService({ [orgId]: 'owner' }, { customers: CUSTOMERS })
})
afterEach(() => restoreOrg())

const sign = (claims: Record<string, unknown>) => signHs256Jwt(claims as never, JWT_SECRET, 3600)
const raw = () => new FoldBase({ baseUrl: fb.base, token: fb.svcToken, tenant: orgId }).withAuth({ uid: 'pay-service', role: 'admin' })
const stream = async (id: string) => (await raw().readStream(id)) as unknown as Ev[]
const logLength = async () => (await raw().readAll({ limit: 100_000 })).length

interface Kind { name: string; token: () => string; actor: () => string; audit: () => Record<string, unknown> }
const KINDS: Kind[] = [
  { name: 'a signed-in person', token: () => makeToken(USER), actor: () => `user:${USER}`,
    audit: () => ({ kind: 'human', actor: `user:${USER}`, actor_id: USER, via: 'session' }) },
  { name: 'the same person by a write API token', token: () => sign({ sub: USER, type: 'human', kind: 'human', via: 'token', credential_id: 'tok_1', access: ['read', 'write'] }), actor: () => `user:${USER}`,
    audit: () => ({ kind: 'human', actor: `user:${USER}`, actor_id: USER, via: 'token', credential_id: 'tok_1' }) },
  { name: 'an agent of that person', token: () => sign({ sub: 'agt-1', type: 'assistant', kind: 'agent', via: 'token', credential_id: 'tok_2', on_behalf_of: `user:${USER}`, actor: 'agent:dev@ada', access: ['read', 'write'] }), actor: () => 'agent:dev@ada',
    audit: () => ({ kind: 'agent', actor: 'agent:dev@ada', actor_id: 'agt-1', via: 'token', on_behalf_of: `user:${USER}`, credential_id: 'tok_2' }) },
  { name: 'an organization\'s key that may write', token: () => sign({ sub: 'key-1', type: 'service', kind: 'machine', via: 'key', credential_id: 'key-1', org_id: orgId, role: 'member', access: ['read', 'write'] }), actor: () => `machine:key-1@${orgId}`,
    audit: () => ({ kind: 'machine', actor: `machine:key-1@${orgId}`, actor_id: 'key-1', via: 'key', credential_id: 'key-1' }) },
  { name: 'a service', token: () => makeServiceToken('stripe-service'), actor: () => 'service:stripe-service',
    audit: () => ({ kind: 'service', actor: 'service:stripe-service', actor_id: 'stripe-service', via: 'client' }) },
]

/** A principal that may read but not write, in the shapes the realm issues them. */
const READERS: Array<[string, () => string]> = [
  ['a person\'s read-only API token', () => sign({ sub: USER, type: 'human', kind: 'human', via: 'token', credential_id: 'tok_r', access: ['read'] })],
  ['a read-only agent', () => sign({ sub: 'agt-1', type: 'assistant', kind: 'agent', via: 'token', on_behalf_of: `user:${USER}`, access: ['read'] })],
  ['a read-only organization key', () => sign({ sub: 'key-r', type: 'service', kind: 'machine', via: 'key', org_id: orgId, role: 'member', access: ['read'] })],
]

const charge = (key = `k-${++keyN}`, extra: Record<string, unknown> = {}) =>
  ({ customerId: 'cus-1', amountCents: 1200, currency: 'EUR', idempotencyKey: key, ...extra })

async function call(method: string, path: string, token: string, body?: unknown, org = orgId) {
  const id = `req-audit-${String(++reqN).padStart(4, '0')}`
  const res = await app.app.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Org-Id': org, 'X-Request-Id': id },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }))
  return { res, id, status: res.status }
}
const paymentOf = async (r: { res: Response }) => ((await r.res.clone().json()) as { payment: { id: string } }).payment.id

describe.each(KINDS)('$name charges', (k) => {
  it('is allowed, and the stored event carries its actor and the envelope of its own request', async () => {
    const made = await call('POST', '/api/payments', k.token(), charge())
    expect(made.status).toBe(201)
    const events = await stream(await paymentOf(made))
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('PaymentCharged')
    expect(events[0]!.actor).toBe(k.actor())
    expect(events[0]!.metadata?.audit).toEqual({ ...k.audit(), client: 'api', org_id: orgId, request_id: made.id })
    expect(events[0]!.correlationId).toBe(made.id)
  })

  it('reads', async () => {
    expect((await call('GET', '/api/payments', k.token())).status).toBe(200)
  })
})

describe('a credential that may not write, writes nothing', () => {
  it.each(READERS)('%s: reads, is refused a charge with the permission named, and the log does not move', async (_n, token) => {
    expect((await call('GET', '/api/payments', token())).status).toBe(200)
    const before = await logLength()
    const refused = await call('POST', '/api/payments', token(), charge())
    expect(refused.status).toBe(403)
    expect(await refused.res.json()).toMatchObject({ error: 'forbidden', permission: 'payment.charge' })
    expect(await logLength()).toBe(before)
  })

  it('a viewer, by session, reads and is refused a charge', async () => {
    restoreOrg(); restoreOrg = fakeOrgService({ [orgId]: 'viewer' }, { customers: CUSTOMERS })
    const before = await logLength()
    expect((await call('GET', '/api/payments', makeToken(USER))).status).toBe(200)
    expect((await call('POST', '/api/payments', makeToken(USER), charge())).status).toBe(403)
    expect(await logLength()).toBe(before)
  })
})

describe('another organization\'s credential', () => {
  it('a person who is a member elsewhere only, and a key of another organization, are refused and nothing is stored', async () => {
    restoreOrg(); restoreOrg = fakeOrgService({ [orgId]: 'owner', [other]: 'owner' }, { customers: CUSTOMERS })
    // the same person is an owner in `other`, and nobody in `orgId`: the caller names `orgId`
    restoreOrg(); restoreOrg = fakeOrgService({ [other]: 'owner' }, { customers: CUSTOMERS })
    const foreignKey = sign({ sub: 'key-9', type: 'service', kind: 'machine', via: 'key', org_id: other, role: 'member', access: ['read', 'write'] })
    const before = await logLength()
    for (const t of [makeToken(USER), foreignKey]) {
      expect((await call('POST', '/api/payments', t, charge())).status).toBe(403)
      expect((await call('GET', '/api/payments', t)).status).toBe(403)
    }
    expect(await logLength()).toBe(before)
  })
})

describe('the outcome fields are a service\'s alone', () => {
  const claim = { status: 'succeeded', providerRef: 'pi_1', provider: 'stripe' }

  it('a person, a write token, an agent and a key are refused, and nothing is stored', async () => {
    const before = await logLength()
    for (const k of KINDS.filter((x) => x.name !== 'a service')) {
      const r = await call('POST', '/api/payments', k.token(), charge(undefined, claim))
      expect(r.status, k.name).toBe(403)
      expect(await r.res.json()).toMatchObject({ error: 'forbidden' })
    }
    expect(await logLength()).toBe(before)
  })

  it('a service records them as given', async () => {
    const r = await call('POST', '/api/payments', makeServiceToken('stripe-service'), charge(undefined, claim))
    expect(r.status).toBe(201)
    expect(((await r.res.json()) as { payment: { provider_ref?: string; providerRef?: string } }).payment).toMatchObject({ providerRef: 'pi_1' })
  })
})

describe('the permission answer is the credential\'s', () => {
  it('with the cache on, a person\'s session and the same person\'s read-only token do not share an answer', async () => {
    const cached = await makeTestApp(fb, orgId, { permission_cache_seconds: 60 })
    const ask = (token: string) => cached.app.fetch(new Request('http://localhost/api/payments', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Org-Id': orgId },
      body: JSON.stringify(charge()),
    }))
    const session = makeToken(USER)
    const ro = sign({ sub: USER, type: 'human', kind: 'human', via: 'token', credential_id: 'tok_r', access: ['read'] })
    expect((await ask(session)).status).toBe(201) // the session's answer is now remembered…
    expect((await ask(ro)).status).toBe(403)       // …and is not the token's
    expect((await ask(session)).status).toBe(201)
    expect(restoreOrg.calls.permissions).toBe(2)   // the session's second ask was served from memory
  })
})
