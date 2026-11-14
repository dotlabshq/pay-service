/**
 * pay-service 0.3: payload fields are snake_case (`amount_cents`, not
 * `amountCents`). History is not rewritten, so the log holds both spellings;
 * foldbase reads a snake_case path from a camelCase payload when the
 * snake_case key is absent. For the one event type: an old-shaped event
 * appended raw and a new one written through the store fold into the same
 * row. The wire answers snake_case and still understands the old request
 * names. Nothing in `src` still reads the old names.
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FoldBase } from '@baseworks/foldbase'
import { bootTestFoldBase, fakeOrgService, makeTestApp, newOrgId, type TestFoldBase } from './setup.js'

type App = Awaited<ReturnType<typeof makeTestApp>>
let fb: TestFoldBase
let app: App
let orgId: string
let restoreOrg: () => void

beforeAll(async () => { fb = await bootTestFoldBase() }, 30_000)
afterAll(async () => { await fb.stop() })
beforeEach(async () => {
  orgId = newOrgId()
  app = await makeTestApp(fb, orgId)
  restoreOrg = fakeOrgService({ [orgId]: 'owner' }, { customers: { 'cus-1': { id: 'cus-1', name: 'Acme' } } })
})
afterEach(() => restoreOrg())

const json = async <T = Record<string, any>>(res: Response) => (await res.json()) as T
const raw = () => new FoldBase({ baseUrl: fb.base, token: fb.svcToken, tenant: orgId }).withAuth({ uid: 'pay-service', role: 'admin' })
let n = 0
const uid = (p: string) => `${p}-${++n}-${Math.random().toString(36).slice(2, 8)}`
const append = (stream: string, payload: Record<string, unknown>) =>
  raw().append(stream, 0, [{ type: 'PaymentCharged', streamId: stream, actor: 'test', payload }], { streamType: 'payment' })

/** A payment as an older release wrote it: camelCase. */
const OLD = (o: Record<string, unknown> = {}) => ({
  customerId: 'cus-1', customerName: 'Acme', amountCents: 4200, currency: 'EUR', invoiceId: 'inv-1', provider: 'manual',
  providerRef: 'manual:abc', status: 'succeeded', failureReason: '', idempotencyKey: 'old-key', shortId: 'sh0001', at: 5, ...o,
})
/** A payment as 0.3 writes it. */
const NEW = (o: Record<string, unknown> = {}) => ({
  customer_id: 'cus-1', customer_name: 'Acme', amount_cents: 4200, currency: 'EUR', invoice_id: 'inv-1', provider: 'manual',
  provider_ref: 'manual:abc', status: 'succeeded', failure_reason: '', idempotency_key: 'new-key', short_id: 'sh0002', at: 5, ...o,
})
const view = ({ id: _i, short_id: _s, idempotency_key: _k, ...p }: Record<string, any>) => p
const get = async (id: string) => (await json<{ payment: Record<string, any> }>(await app.get(`/payments/${id}`))).payment

describe('PaymentCharged folds the same in either spelling', () => {
  it('an old-shaped event and a new one make the same row', async () => {
    const a = uid('p'), b = uid('p')
    await append(a, OLD())
    await append(b, NEW())
    const ra = await get(a), rb = await get(b)
    expect(view(ra)).toEqual(view(rb))
    expect(ra).toMatchObject({ short_id: 'sh0001', idempotency_key: 'old-key', amount_cents: 4200, customer_name: 'Acme', invoice_id: 'inv-1', provider_ref: 'manual:abc', created_at: 5 })
    expect(rb).toMatchObject({ short_id: 'sh0002', idempotency_key: 'new-key' })
  })

  it('an old-shaped payment is found by short id and by key, listed by customer, and a repeat of its key does not charge again', async () => {
    // A release before 0.3 derived the stream id from the key, as this one does.
    const a = createHash('sha256').update('payment:old-k2').digest('hex')
    await append(a, OLD({ idempotencyKey: 'old-k2', shortId: 'sh0003' }))
    expect((await get('sh0003'))['id']).toBe(a)
    expect((await get('old-k2'))['id']).toBe(a)
    const listed = await json<{ payments: Array<Record<string, any>> }>(await app.get('/payments?customer=cus-1'))
    expect(listed.payments.map((p) => p['id'])).toEqual([a])
    const again = await app.post('/payments', { customer_id: 'cus-1', amount_cents: 99, currency: 'EUR', idempotency_key: 'old-k2' })
    expect((await json<{ payment: Record<string, any> }>(again)).payment).toMatchObject({ id: a, amount_cents: 4200 })
    expect((await json<{ payments: unknown[] }>(await app.get('/payments'))).payments).toHaveLength(1)
  })

  it('what the store writes is snake_case, and the log has no camelCase key', async () => {
    const made = await json<{ payment: Record<string, any> }>(await app.post('/payments', { customer_id: 'cus-1', amount_cents: 700, currency: 'USD', idempotency_key: 'k-new', invoice_id: 'inv-9' }))
    const events = await raw().readStream(made.payment['id'])
    expect(events).toHaveLength(1)
    expect(Object.keys(events[0]!.payload).filter((k) => /[A-Z]/.test(k))).toEqual([])
    expect(events[0]!.payload).toMatchObject({ customer_id: 'cus-1', customer_name: 'Acme', amount_cents: 700, invoice_id: 'inv-9', idempotency_key: 'k-new' })
  })
})

describe('the wire', () => {
  it('answers in snake_case only', async () => {
    const made = await json<{ payment: Record<string, any> }>(await app.post('/api/payments', { customer_id: 'cus-1', amount_cents: 700, currency: 'USD', idempotency_key: 'k-w' }))
    expect(Object.keys(made.payment).sort()).toEqual([
      'amount_cents', 'created_at', 'currency', 'customer_id', 'customer_name', 'failure_reason', 'id', 'idempotency_key',
      'invoice_id', 'provider', 'provider_ref', 'short_id', 'status',
    ])
  })

  it('understands the request names it used to have, and the snake_case one wins when both are sent', async () => {
    const res = await app.post('/api/payments', { customerId: 'cus-1', amountCents: 900, currency: 'USD', idempotencyKey: 'k-old', invoiceId: 'inv-2', simulateFailure: true })
    expect(res.status).toBe(201)
    expect((await json<{ payment: Record<string, any> }>(res)).payment).toMatchObject({ customer_id: 'cus-1', amount_cents: 900, invoice_id: 'inv-2', status: 'failed', failure_reason: 'card_declined' })
    const both = await app.post('/api/payments', { customerId: 'nobody', customer_id: 'cus-1', amount_cents: 1, currency: 'USD', idempotency_key: 'k-both' })
    expect(both.status).toBe(201)
  })

  it('a bad amount is refused under either spelling', async () => {
    expect((await app.post('/api/payments', { customerId: 'cus-1', amountCents: 0, currency: 'USD', idempotencyKey: 'k-z' })).status).toBe(400)
    expect((await app.post('/api/payments', { customer_id: 'cus-1', amount_cents: -5, currency: 'USD', idempotency_key: 'k-z' })).status).toBe(400)
  })

  it('lists by customer under `customer` and `customer_id`', async () => {
    await app.post('/api/payments', { customer_id: 'cus-1', amount_cents: 100, currency: 'USD', idempotency_key: 'k-l1' })
    for (const q of ['customer=cus-1', 'customer_id=cus-1']) {
      expect((await json<{ payments: unknown[] }>(await app.get(`/api/payments?${q}`))).payments).toHaveLength(1)
    }
    expect((await json<{ payments: unknown[] }>(await app.get('/api/payments?customer_id=nobody'))).payments).toHaveLength(0)
  })
})

// ── nothing in src still speaks the old names ────────────────────────────────
// Not read: the request-name table in the routes, which exists to understand the old names.

const here = dirname(fileURLToPath(import.meta.url))
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? (f === '__tests__' ? [] : walk(p)) : p.endsWith('.ts') ? [p] : []
  })

describe('the source is snake_case, and never reads the Authorization header', () => {
  const OLDNAMES = /\.(userId|orgId|orgRole|scopeId|tokenType|requestId|realmToken)\b|get\('(orgId|orgRole|scopeId|requestId|realmToken)'\)|\.(customerId|customerName|amountCents|invoiceId|providerRef|failureReason|idempotencyKey|shortId|createdAt)\b/
  const RAW_AUTH = /(header|headers\.get)\(\s*['"][Aa]uthorization['"]/
  const files = [...walk(resolve(here, '..')), ...walk(resolve(here, '../../clients/ts/src')).filter((f) => !f.includes('__tests__'))]
  it.each(files.map((f) => [f.slice(resolve(here, '../..').length + 1), f] as const))('%s', (_n, f) => {
    const lines = readFileSync(f, 'utf8').split('\n').map((l, i) => [i + 1, l] as const)
    const hits = lines.filter(([, l]) => OLDNAMES.test(l) && !/deprecated/.test(l))
    expect(hits).toEqual([])
    // the client SETS the header; nothing reads it
    const reads = lines.filter(([, l]) => RAW_AUTH.test(l) && !/h\['Authorization'\]/.test(l))
    expect(reads).toEqual([])
  })
})
