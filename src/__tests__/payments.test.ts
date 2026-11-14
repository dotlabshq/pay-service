import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import {
  bootTestFoldBase, fakeOrgService, makeServiceToken, makeTestApp, newOrgId, type TestFoldBase,
} from './setup.js'

type App = Awaited<ReturnType<typeof makeTestApp>>
type Payment = {
  id: string; short_id: string; customer_id: string; customer_name: string | null
  amount_cents: number; currency: string; invoice_id: string | null
  provider: string; provider_ref: string | null
  status: string; failure_reason: string | null; idempotency_key: string
}

let fb: TestFoldBase
let app: App
let orgId: string
let restoreOrg: () => void

const CUSTOMER = { id: 'cus_1', name: 'Acme GmbH' }
const json = <T>(res: Response) => res.json() as Promise<T>

let key = 0
const charge = (over: Record<string, unknown> = {}, o?: { org?: string | null; token?: string }) =>
  app.post('/payments', {
    customer_id: 'cus_1',
    amount_cents: 9800,
    currency: 'EUR',
    provider: 'manual',
    idempotency_key: `k-${++key}`,
    ...over,
  }, o)

const arrange = (extra: Record<string, string> = {}) =>
  fakeOrgService({ [orgId]: 'owner', ...extra }, { customers: { cus_1: CUSTOMER } })

beforeAll(async () => { fb = await bootTestFoldBase() }, 30_000)
afterAll(async () => { await fb.stop() })
beforeEach(async () => {
  orgId = newOrgId()
  app = await makeTestApp(fb, orgId)
  restoreOrg = arrange()
})
afterEach(() => restoreOrg())

// ── the two gates every request passes ───────────────────────────────────────

describe('a request needs an identity and an org', () => {
  it('no token is 401', async () => {
    expect((await app.unauth('/payments')).status).toBe(401)
  })

  it('no X-Org-Id is 400', async () => {
    const res = await app.get('/payments', { org: null })
    expect(res.status).toBe(400)
    expect((await json<{ error: string }>(res)).error).toBe('org_required')
  })

  it('an org the caller is not a member of is 403', async () => {
    expect((await app.get('/payments', { org: 'org-somebody-elses' })).status).toBe(403)
  })
})

// ── charging ─────────────────────────────────────────────────────────────────

describe('charges', () => {
  it('records the money and snapshots who it came from', async () => {
    const res = await charge()
    expect(res.status).toBe(201)
    const { payment } = await json<{ payment: Payment }>(res)
    expect(payment).toMatchObject({
      customer_id: 'cus_1', customer_name: 'Acme GmbH',
      amount_cents: 9800, currency: 'EUR', provider: 'manual', status: 'succeeded',
    })
  })

  it('a customer nobody has is 404, and nothing is recorded', async () => {
    const res = await charge({ customer_id: 'cus_ghost' })
    expect(res.status).toBe(404)

    const { payments } = await json<{ payments: Payment[] }>(await app.get('/payments'))
    expect(payments).toHaveLength(0)
  })

  it('a zero or negative amount is refused', async () => {
    expect((await charge({ amount_cents: 0 })).status).toBe(400)
    expect((await charge({ amount_cents: -100 })).status).toBe(400)
  })

  it('reads back by id, short id and idempotency key', async () => {
    const { payment } = await json<{ payment: Payment }>(await charge({ idempotency_key: 'inv-1-attempt-1' }))
    for (const ref of [payment.id, payment.short_id, 'inv-1-attempt-1']) {
      const got = await json<{ payment: Payment }>(await app.get(`/payments/${ref}`))
      expect(got.payment.id, `ref=${ref}`).toBe(payment.id)
    }
  })

  it('a built-in provider can be made to fail, and the reason is kept', async () => {
    const { payment } = await json<{ payment: Payment }>(await charge({ simulate_failure: true }))
    expect(payment.status).toBe('failed')
    expect(payment.failure_reason).toBe('card_declined')
  })
})

// ── the same key is the same charge ──────────────────────────────────────────
//
// A network that times out after the charge went through is the normal case.
// The key, not the request, is what identifies an attempt.

describe('charging twice with one key takes the money once', () => {
  it('answers with the charge that already exists', async () => {
    const first = await json<{ payment: Payment }>(await charge({ idempotency_key: 'same-key' }))
    const second = await json<{ payment: Payment }>(await charge({ idempotency_key: 'same-key' }))
    expect(second.payment.id).toBe(first.payment.id)

    const { payments } = await json<{ payments: Payment[] }>(await app.get('/payments'))
    expect(payments).toHaveLength(1)
  })

  it('and does not re-run the provider — a repeat of a failed charge stays failed', async () => {
    const failed = await json<{ payment: Payment }>(
      await charge({ idempotency_key: 'stubborn', simulate_failure: true }),
    )
    expect(failed.payment.status).toBe('failed')

    // The retry asks for success; the key already has an answer.
    const retry = await json<{ payment: Payment }>(await charge({ idempotency_key: 'stubborn' }))
    expect(retry.payment.status).toBe('failed')
    expect(retry.payment.id).toBe(failed.payment.id)
  })

  it('the same key in another org is a different charge', async () => {
    const other = newOrgId()
    restoreOrg()
    restoreOrg = arrange({ [other]: 'owner' })

    await charge({ idempotency_key: 'shared' })
    await charge({ idempotency_key: 'shared' }, { org: other })

    const ours = await json<{ payments: Payment[] }>(await app.get('/payments'))
    const theirs = await json<{ payments: Payment[] }>(await app.get('/payments', { org: other }))
    expect(ours.payments).toHaveLength(1)
    expect(theirs.payments).toHaveLength(1)
  })
})

// ── an external provider's outcome is recorded, not invented ─────────────────
//
// `status`, `provider_ref` and `failure_reason` assert that money already changed
// hands somewhere else. Whoever can set them can write a succeeded payment into
// the ledger without collecting anything, so only a service may.

describe("an outcome can only be asserted by whoever collected it", () => {
  it('a person is refused, whatever they claim', async () => {
    const res = await charge({ provider: 'stripe', status: 'succeeded', provider_ref: 'pi_forged' })
    expect(res.status).toBe(403)
    expect((await json<{ message: string }>(res)).message).toMatch(/service-only/)

    const { payments } = await json<{ payments: Payment[] }>(await app.get('/payments'))
    expect(payments).toHaveLength(0)
  })

  it('a service may record what its provider actually did, as it was', async () => {
    const { payment } = await json<{ payment: Payment }>(await charge({
      provider: 'stripe', status: 'failed', provider_ref: 'pi_123', failure_reason: 'insufficient_funds',
    }, { token: makeServiceToken('stripe-service') }))

    expect(payment).toMatchObject({
      provider: 'stripe', status: 'failed', provider_ref: 'pi_123', failure_reason: 'insufficient_funds',
    })
  })
})

// ── org isolation ────────────────────────────────────────────────────────────

describe('one organization, one record of what it collected', () => {
  it('lists what this org collected, and nothing another org collected', async () => {
    const other = newOrgId()
    restoreOrg()
    restoreOrg = arrange({ [other]: 'owner' })

    await charge({ amount_cents: 1000 })
    await charge({ amount_cents: 2000 }, { org: other })

    const ours = await json<{ payments: Payment[] }>(await app.get('/payments'))
    const theirs = await json<{ payments: Payment[] }>(await app.get('/payments', { org: other }))
    expect(ours.payments.map((p) => p.amount_cents)).toEqual([1000])
    expect(theirs.payments.map((p) => p.amount_cents)).toEqual([2000])
  })

  it('a charge made under a slug is found under the id', async () => {
    restoreOrg()
    restoreOrg = fakeOrgService({ [orgId]: 'owner' }, { aliases: { acme: orgId }, customers: { cus_1: CUSTOMER } })

    await charge({}, { org: 'acme' })
    const byId = await json<{ payments: Payment[] }>(await app.get('/payments', { org: orgId }))
    expect(byId.payments).toHaveLength(1)
  })
})

// ── where the routes live ────────────────────────────────────────────────────

describe('mount paths', () => {
  it('serves the same resource at the root and under the legacy /v1 prefix', async () => {
    await charge()
    const root = await app.get('/payments')
    const legacy = await app.get('/v1/payments')
    expect(root.status).toBe(200)
    expect(await root.json()).toEqual(await legacy.json())
  })

  it('answers the manifest without a token', async () => {
    const res = await app.app.fetch(new Request('http://localhost/.well-known/service'))
    expect(res.status).toBe(200)
    expect(await json<{ name: string; api_version: string }>(res)).toMatchObject({
      name: 'pay', api_version: '1.0',
    })
  })
})
