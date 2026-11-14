/**
 * Every route asks org-service for a permission, never a role; the service
 * registers its own actions; what is not answered is refused, not allowed.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { bootTestFoldBase, fakeOrgService, makeServiceToken, makeTestApp, makeToken, newOrgId, type FakeOrgOptions, type TestFoldBase } from './setup.js'
import { PAY_ACTIONS, orgAccess, registerWithOrg } from '../lib/org.js'

type App = Awaited<ReturnType<typeof makeTestApp>>
let fb: TestFoldBase
let app: App
let orgId: string
let restore: ReturnType<typeof fakeOrgService> | undefined

const json = async <T>(res: Response) => (await res.json()) as T
const CUSTOMERS = { 'cus-1': { id: 'cus-1', name: 'Acme' } }
const as = (role: string, o: FakeOrgOptions = {}) => { restore?.(); restore = fakeOrgService({ [orgId]: role }, { customers: CUSTOMERS, ...o }) }
const charge = (key: string) => ({ customer_id: 'cus-1', amount_cents: 100, currency: 'USD', idempotency_key: key })

beforeAll(async () => { fb = await bootTestFoldBase() }, 30_000)
afterAll(async () => { await fb.stop() })
beforeEach(async () => { orgId = newOrgId(); app = await makeTestApp(fb, orgId); as('owner') })
afterEach(() => { restore?.(); restore = undefined })

describe('a route asks for a permission', () => {
  it('a viewer reads and cannot charge', async () => {
    await app.post('/api/payments', charge('k-1'))
    as('viewer')
    expect((await app.get('/api/payments')).status).toBe(200)
    expect((await app.get('/api/payments/k-1')).status).toBe(200)
    const refused = await app.post('/api/payments', charge('k-2'))
    expect(refused.status).toBe(403)
    expect(await json(refused)).toMatchObject({ error: 'forbidden', permission: 'payment.charge' })
  })

  it('a member charges', async () => {
    as('member')
    expect((await app.post('/api/payments', charge('k-1'))).status).toBe(201)
  })

  it('with no manifest registered, a member of the org is refused everything', async () => {
    as('owner', { registered: false })
    expect(await json(await app.get('/api/payments'))).toMatchObject({ error: 'forbidden', permission: 'payment.read' })
    expect((await app.post('/api/payments', charge('k-1'))).status).toBe(403)
  })

  it('when org-service cannot be asked, the answer is 502 and not yes', async () => {
    as('owner', { permissionsDown: true })
    const res = await app.get('/api/payments')
    expect(res.status).toBe(502)
    expect((await json<{ error: string }>(res)).error).toBe('authz_unavailable')
  })

  it('a service token acts as itself and is not asked about', async () => {
    as('none')
    const res = await app.get('/api/payments', { token: makeServiceToken('stripe-service') })
    expect(res.status).toBe(200)
    expect(restore!.calls.permissions).toBe(0)
  })

  it('every route that exists is gated: an unlisted action is not invented', () => {
    expect(Object.keys(PAY_ACTIONS)).toEqual(['payment.read', 'payment.charge'])
  })
})

describe('customers-service is asked with the realm token and the resolved org', () => {
  it('forwards the bearer this request ran on, for the org id and not the slug', async () => {
    as('owner', { aliases: { acme: orgId } })
    const token = makeToken('u-1')
    expect((await app.post('/api/payments', charge('k-1'), { token, org: 'acme' })).status).toBe(201)
    expect(restore!.customers).toEqual([{ url: 'http://customers.test/customers/cus-1', authorization: `Bearer ${token}`, org: orgId }])
  })
})

describe('the service registers its own actions', () => {
  it('posts its manifest to /_/apps/register as the service pay', async () => {
    const seen: { url: string; auth: string; body: { name: string; actions: Record<string, unknown> } }[] = []
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), auth: String(new Headers(init?.headers).get('authorization') ?? ''), body: JSON.parse(String(init?.body)) })
      return new Response(JSON.stringify({ app: { name: 'pay' } }), { status: 201, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const access = orgAccess('http://org.test/api', { JWT_SECRET: 'test-secret-32-chars-long-enough!' }, fetchImpl)
    expect(await registerWithOrg(access, { attempts: 1, log: () => {} })).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.url).toBe('http://org.test/_/apps/register')
    const claims = JSON.parse(Buffer.from(seen[0]!.auth.split('.')[1]!, 'base64url').toString()) as { sub: string; type: string }
    expect(claims).toMatchObject({ sub: 'pay', type: 'service' })
    expect(seen[0]!.body.name).toBe('pay')
    expect(seen[0]!.body.actions).toEqual(PAY_ACTIONS)
  })

  it('a refusal is reported, never thrown', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: { 'content-type': 'application/json' } })) as typeof fetch
    const access = orgAccess('http://org.test', { JWT_SECRET: 'test-secret-32-chars-long-enough!' }, fetchImpl)
    expect(await registerWithOrg(access, { attempts: 1, log: () => {} })).toBe(false)
  })
})
