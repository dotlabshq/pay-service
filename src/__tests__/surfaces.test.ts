/**
 * The mounts (workspace ADR 0003): the API under `/api`, `/healthz` at the
 * root only, the two older mounts kept for now with the same gates.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { bootTestFoldBase, fakeOrgService, makeTestApp, newOrgId, type TestFoldBase } from './setup.js'

type App = Awaited<ReturnType<typeof makeTestApp>>
let fb: TestFoldBase
let app: App
let orgId: string
let restore: () => void

const json = async <T>(res: Response) => (await res.json()) as T
const CUSTOMERS = { 'c-1': { id: 'c-1', name: 'Acme' } }

beforeAll(async () => { fb = await bootTestFoldBase() }, 30_000)
afterAll(async () => { await fb.stop() })
beforeEach(async () => { orgId = newOrgId(); app = await makeTestApp(fb, orgId); restore = fakeOrgService({ [orgId]: 'owner' }, { customers: CUSTOMERS }) })
afterEach(() => restore())

const charge = (key: string) => ({ customer_id: 'c-1', amount_cents: 500, currency: 'USD', idempotency_key: key })

describe('the API is under /api', () => {
  it('answers there, discovery and the contract included', async () => {
    expect((await app.post('/api/payments', charge('k-1'))).status).toBe(201)
    expect((await json<{ payments: unknown[] }>(await app.get('/api/payments'))).payments).toHaveLength(1)
    expect((await json<{ name: string }>(await app.unauth('/api/.well-known/service'))).name).toBe('pay')
    expect((await app.unauth('/api/openapi.yaml')).status).toBe(200)
  })

  it('/healthz is at the root only, so no published prefix reaches it', async () => {
    expect((await app.unauth('/healthz')).status).toBe(200)
    expect((await app.unauth('/api/healthz')).status).toBe(401)
  })

  it('the older mounts still answer, with the same gates', async () => {
    expect((await app.get('/payments')).status).toBe(200)
    expect((await app.get('/v1/payments')).status).toBe(200)
    expect((await app.unauth('/v1/payments')).status).toBe(401)
    expect((await app.unauth('/.well-known/service')).status).toBe(200)
  })
})
