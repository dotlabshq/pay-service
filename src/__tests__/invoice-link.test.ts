/**
 * 1.1.0 (clave #188): a payment shows the invoice it settles, read from invoice-service with the request's token;
 * the link is written once on the pay record (`PaymentInvoiceLinked`), idempotent for the same invoice and
 * `409 already_linked` for another; payments filter by invoice.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FoldBase } from '@baseworks/foldbase'
import { signHs256Jwt } from '@baseworks/auth/jwt'
import { JWT_SECRET, bootTestFoldBase, fakeOrgService, makeServiceToken, makeTestApp, makeToken, newOrgId, type FakeOrgOptions, type TestFoldBase } from './setup.js'

type App = Awaited<ReturnType<typeof makeTestApp>>
type Ev = { type: string; actor?: string; payload: Record<string, any>; metadata?: { audit?: Record<string, unknown> } }
let fb: TestFoldBase
let app: App
let orgId: string
let restore: ReturnType<typeof fakeOrgService>
let n = 0

const json = async <T = Record<string, any>>(res: Response) => (await res.json()) as T
const CUSTOMERS = { 'cus-1': { id: 'cus-1', name: 'Acme' } }
const INVOICE_V10 = { id: 'inv-1', number: 12, status: 'finalized', total_cents: 5000, currency: 'EUR' }
const INVOICE_V11 = { id: 'inv-2', number: null, source: 'stripe', external_refs: [{ system: 'stripe', id: 'in_1', number: 'ABC-001' }], total_cents: 900, currency: 'USD', payment_status: 'paid' }
const arrange = (role = 'owner', o: FakeOrgOptions = {}) => { restore?.(); restore = fakeOrgService({ [orgId]: role }, { customers: CUSTOMERS, invoices: { 'inv-1': INVOICE_V10, 'inv-2': INVOICE_V11 }, ...o }) }
const raw = () => new FoldBase({ baseUrl: fb.base, token: fb.svcToken, tenant: orgId }).withAuth({ uid: 'pay-service', role: 'admin' })
const charge = async (extra: Record<string, unknown> = {}, token?: string) => {
  const res = await app.post('/api/payments', { customer_id: 'cus-1', amount_cents: 5000, currency: 'EUR', idempotency_key: `k-${++n}`, ...extra }, token ? { token } : {})
  expect(res.status).toBe(201)
  return (await json<{ payment: Record<string, any> }>(res)).payment
}
const link = (ref: string, invoice_id: unknown, token?: string) => app.app.fetch(new Request(`http://localhost/api/payments/${ref}/invoice`, {
  method: 'PATCH', headers: { Authorization: `Bearer ${token ?? makeToken('u-ada')}`, 'Content-Type': 'application/json', 'X-Org-Id': orgId }, body: JSON.stringify({ invoice_id }),
}))

beforeAll(async () => { fb = await bootTestFoldBase() }, 30_000)
afterAll(async () => { await fb.stop() })
beforeEach(async () => { orgId = newOrgId(); app = await makeTestApp(fb, orgId); arrange() })
afterEach(() => restore())

describe('GET /payments/:ref embeds the invoice', () => {
  it('a payment with no invoice answers invoice: null and asks invoice-service nothing', async () => {
    const p = await charge()
    const got = (await json<{ payment: Record<string, any> }>(await app.get(`/api/payments/${p['id']}`))).payment
    expect(got['invoice']).toBeNull()
    expect(got).not.toHaveProperty('invoice_unavailable')
    expect(restore.invoices).toEqual([])
  })

  it('an invoice of invoice-service 1.0 (no source, refs or payment_status) reads those as null; number is kept', async () => {
    const p = await charge({ invoice_id: 'inv-1' })
    const got = (await json<{ payment: Record<string, any> }>(await app.get(`/api/payments/${p['id']}`))).payment
    expect(got['invoice']).toEqual({ id: 'inv-1', number: 12, source: null, external_refs: null, total_cents: 5000, currency: 'EUR', payment_status: null })
    expect(got).not.toHaveProperty('invoice_unavailable')
    expect(got['invoice_id']).toBe('inv-1')
  })

  it('an invoice of 1.1 shows source, external refs and payment status; a mirror has no number', async () => {
    const p = await charge({ invoice_id: 'inv-2' })
    const got = (await json<{ payment: Record<string, any> }>(await app.get(`/api/payments/${p['short_id']}`))).payment
    expect(got['invoice']).toEqual({ id: 'inv-2', number: null, source: 'stripe', external_refs: [{ system: 'stripe', id: 'in_1', number: 'ABC-001' }], total_cents: 900, currency: 'USD', payment_status: 'paid' })
  })

  it('invoice-service is asked with the request\'s own token and the resolved org, at its /invoices/:ref', async () => {
    const p = await charge({ invoice_id: 'inv-1' })
    const token = makeToken('u-bob')
    await app.get(`/api/payments/${p['id']}`, { token })
    expect(restore.invoices.at(-1)).toEqual({ url: 'http://invoice.test/invoices/inv-1', authorization: `Bearer ${token}`, org: orgId })
  })

  it('invoice-service down: the payment still answers, with { id } and invoice_unavailable', async () => {
    const p = await charge({ invoice_id: 'inv-1' })
    arrange('owner', { invoiceDown: true })
    const res = await app.get(`/api/payments/${p['id']}`)
    expect(res.status).toBe(200)
    const got = (await json<{ payment: Record<string, any> }>(res)).payment
    expect(got).toMatchObject({ id: p['id'], amount_cents: 5000, invoice_id: 'inv-1', invoice: { id: 'inv-1' }, invoice_unavailable: true })
    expect(got['invoice']).toEqual({ id: 'inv-1' })
  })

  it('an invoice that is not there (404) is also unavailable, not an error', async () => {
    const p = await charge({ invoice_id: 'inv-gone' })
    const got = (await json<{ payment: Record<string, any> }>(await app.get(`/api/payments/${p['id']}`))).payment
    expect(got).toMatchObject({ invoice: { id: 'inv-gone' }, invoice_unavailable: true })
  })

  it('a network failure is unavailable too, and the list does not read invoices at all', async () => {
    const p = await charge({ invoice_id: 'inv-1' })
    const real = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith('http://invoice.test')) throw new TypeError('fetch failed')
      return real(input as never, init)
    }) as typeof fetch
    try {
      expect((await json<{ payment: Record<string, any> }>(await app.get(`/api/payments/${p['id']}`))).payment['invoice_unavailable']).toBe(true)
    } finally { globalThis.fetch = real }
    arrange()
    const listed = await json<{ payments: Array<Record<string, any>> }>(await app.get('/api/payments'))
    expect(listed.payments[0]).not.toHaveProperty('invoice')
    expect(restore.invoices).toEqual([])
  })
})

describe('PATCH /payments/:ref/invoice links once', () => {
  it('links a payment recorded before its invoice was known, and the event is on the pay record with its audit', async () => {
    const p = await charge()
    const res = await link(p['id'], 'inv-1', makeToken('u-ada'))
    expect(res.status).toBe(200)
    const got = (await json<{ payment: Record<string, any> }>(res)).payment
    expect(got).toMatchObject({ id: p['id'], invoice_id: 'inv-1', invoice: { id: 'inv-1', number: 12 } })
    const events = (await raw().readStream(p['id'])) as unknown as Ev[]
    expect(events.map((e) => e.type)).toEqual(['PaymentCharged', 'PaymentInvoiceLinked'])
    expect(events[1]!.payload).toMatchObject({ invoice_id: 'inv-1' })
    expect(events[1]!.actor).toBe('user:u-ada')
    expect(events[1]!.metadata?.audit).toMatchObject({ kind: 'human', actor: 'user:u-ada', via: 'session', org_id: orgId })
    // and it is what the list filter finds
    const byInvoice = await json<{ payments: Array<Record<string, any>> }>(await app.get('/api/payments?invoice_id=inv-1'))
    expect(byInvoice.payments.map((x) => x['id'])).toEqual([p['id']])
  })

  it('the same invoice again changes nothing (no second event); by short id and by key too', async () => {
    const p = await charge()
    expect((await link(p['id'], 'inv-1')).status).toBe(200)
    expect((await link(p['id'], 'inv-1')).status).toBe(200)
    expect((await link(p['short_id'], 'inv-1')).status).toBe(200)
    expect((await link(p['idempotency_key'], 'inv-1')).status).toBe(200)
    expect(((await raw().readStream(p['id'])) as unknown as Ev[]).filter((e) => e.type === 'PaymentInvoiceLinked')).toHaveLength(1)
  })

  it('another invoice is 409 already_linked, and nothing is stored', async () => {
    const p = await charge()
    await link(p['id'], 'inv-1')
    const res = await link(p['id'], 'inv-2')
    expect(res.status).toBe(409)
    expect(await json(res)).toMatchObject({ error: 'already_linked' })
    expect(((await raw().readStream(p['id'])) as unknown as Ev[])).toHaveLength(2)
    expect((await json<{ payment: Record<string, any> }>(await app.get(`/api/payments/${p['id']}`))).payment['invoice_id']).toBe('inv-1')
  })

  it('a payment charged with an invoice is linked from the start: the same is idempotent, another is refused', async () => {
    const p = await charge({ invoice_id: 'inv-1' })
    expect((await link(p['id'], 'inv-1')).status).toBe(200)
    expect((await link(p['id'], 'inv-2')).status).toBe(409)
    expect(((await raw().readStream(p['id'])) as unknown as Ev[])).toHaveLength(1)
  })

  it('an unknown payment is 404, and an empty or missing invoice_id is 400', async () => {
    expect((await link('nope', 'inv-1')).status).toBe(404)
    const p = await charge()
    expect((await link(p['id'], '')).status).toBe(400)
    expect((await link(p['id'], undefined)).status).toBe(400)
  })

  it('the old camelCase name is read', async () => {
    const p = await charge()
    const res = await app.app.fetch(new Request(`http://localhost/api/payments/${p['id']}/invoice`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${makeToken()}`, 'Content-Type': 'application/json', 'X-Org-Id': orgId }, body: JSON.stringify({ invoiceId: 'inv-1' }),
    }))
    expect(res.status).toBe(200)
  })

  it('works under the legacy mounts too, with the same gates', async () => {
    const p = await charge()
    expect((await app.patch(`/v1/payments/${p['id']}/invoice`, { invoice_id: 'inv-1' })).status).toBe(200)
    arrange('viewer')
    expect((await app.patch(`/payments/${p['id']}/invoice`, { invoice_id: 'inv-1' })).status).toBe(403)
  })
})

describe('who may link', () => {
  const sign = (c: Record<string, unknown>) => signHs256Jwt(c as never, JWT_SECRET, 3600)
  const principals: Array<[string, string, boolean]> = [
    ['a person\'s read-only API token', sign({ sub: 'u-ada', type: 'human', kind: 'human', via: 'token', credential_id: 't1', access: ['read'] }), false],
    ['a read-only agent', sign({ sub: 'agt-1', type: 'assistant', kind: 'agent', via: 'token', on_behalf_of: 'user:u-ada', access: ['read'] }), false],
    ['a read-only organization key', sign({ sub: 'key-r', type: 'service', kind: 'machine', via: 'key', org_id: '', role: 'member', access: ['read'] }), false],
    ['a write API token', sign({ sub: 'u-ada', type: 'human', kind: 'human', via: 'token', credential_id: 't2', access: ['read', 'write'] }), true],
    ['an agent that may write', sign({ sub: 'agt-1', type: 'assistant', kind: 'agent', via: 'token', actor: 'agent:dev@ada', on_behalf_of: 'user:u-ada', access: ['read', 'write'] }), true],
    ['a service', makeServiceToken('stripe-service'), true],
  ]

  it.each(principals)('%s', async (_n, token, allowed) => {
    const p = await charge()
    const before = ((await raw().readStream(p['id'])) as unknown as Ev[]).length
    // the organization key is bound to its org
    const useToken = _n.includes('organization key') ? sign({ sub: 'key-r', type: 'service', kind: 'machine', via: 'key', org_id: orgId, role: 'member', access: ['read'] }) : token
    const res = await link(p['id'], 'inv-1', useToken)
    expect(res.status).toBe(allowed ? 200 : 403)
    if (!allowed) {
      expect(await json(res)).toMatchObject({ error: 'forbidden', permission: 'payment.link_invoice' })
      expect(((await raw().readStream(p['id'])) as unknown as Ev[]).length).toBe(before)
    } else {
      expect(((await raw().readStream(p['id'])) as unknown as Ev[]).length).toBe(before + 1)
    }
  })

  it('a viewer reads (and reads the invoice) and cannot link; another organization\'s member cannot reach it', async () => {
    const p = await charge({ invoice_id: 'inv-1' })
    arrange('viewer')
    expect((await app.get(`/api/payments/${p['id']}`)).status).toBe(200)
    expect((await link(p['id'], 'inv-1')).status).toBe(403)
    restore(); restore = fakeOrgService({ [newOrgId()]: 'owner' }, { customers: CUSTOMERS })
    expect((await link(p['id'], 'inv-1')).status).toBe(403)
  })
})

describe('the invoice filter', () => {
  it('lists the payments of one invoice, combines with the others, and an unknown invoice lists none', async () => {
    const a = await charge({ invoice_id: 'inv-1' })
    const b = await charge({ invoice_id: 'inv-1', provider: 'mock', simulate_failure: true })
    await charge({ invoice_id: 'inv-2' })
    await charge()
    const ids = async (q: string) => (await json<{ payments: Array<{ id: string }> }>(await app.get(`/api/payments?${q}`))).payments.map((x) => x.id).sort()
    expect(await ids('invoice_id=inv-1')).toEqual([a['id'], b['id']].sort())
    expect(await ids('invoice_id=inv-1&status=failed')).toEqual([b['id']])
    expect(await ids('invoice_id=nobody')).toEqual([])
    expect((await ids('')).length).toBe(4)
  })
})

describe('an event written before 1.1.0 and one written after fold the same', () => {
  it('PaymentInvoiceLinked in camelCase (invoiceId) links as the snake_case one does', async () => {
    const mk = async (spelling: 'old' | 'new', key: string) => {
      const p = await charge({ idempotency_key: key })
      const v = (await raw().streamVersion(p['id'])).version
      await raw().append(p['id'], v, [{ type: 'PaymentInvoiceLinked', streamId: p['id'], actor: 'test', payload: spelling === 'old' ? { invoiceId: 'inv-1', at: 9 } : { invoice_id: 'inv-1', at: 9 } }], { streamType: 'payment' })
      return p['id'] as string
    }
    const a = await mk('old', 'k-old'), b = await mk('new', 'k-new')
    const get = async (id: string) => (await json<{ payment: Record<string, any> }>(await app.get(`/api/payments/${id}`))).payment
    expect((await get(a))['invoice_id']).toBe('inv-1')
    expect((await get(b))['invoice_id']).toBe('inv-1')
    expect((await link(a, 'inv-2')).status).toBe(409)
  })
})

describe('without INVOICE_SERVICE_URL', () => {
  it('a payment with an invoice answers invoice_unavailable and never fails', async () => {
    const { readInvoice } = await import('../lib/invoice.js')
    expect(await readInvoice(undefined, 'tok', orgId, 'inv-1')).toEqual({ invoice: { id: 'inv-1' }, unavailable: true })
  })
})
