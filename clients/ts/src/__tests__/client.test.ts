import { describe, expect, it } from 'vitest'
import { createPayClient, PayError } from '../client.js'

const ROW = {
  id: 'p-1', short_id: 'py1', customer_id: 'c-1', customer_name: 'Acme', amount_cents: 5000, currency: 'USD', invoice_id: null,
  provider: 'manual', provider_ref: 'manual:py1', status: 'succeeded', failure_reason: null, idempotency_key: 'k-1', created_at: 7,
}

function fake(status = 200, body: unknown = { payment: ROW }) {
  const seen: { url: string; method: string; headers: Headers; body: Record<string, unknown> | undefined }[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, method: String(init.method), headers: new Headers(init.headers), body: init.body ? JSON.parse(String(init.body)) : undefined })
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof globalThis.fetch
  return { seen, fetch }
}

describe('PayClient', () => {
  it('base_url and org_id are the options; baseUrl and orgId still work', async () => {
    const a = fake(); await createPayClient({ base_url: 'http://pay.test/', org_id: 'org-1', token: 't', fetch: a.fetch }).get('p-1')
    const b = fake(); await createPayClient({ baseUrl: 'http://pay.test', orgId: 'org-1', token: 't', fetch: b.fetch }).get('p-1')
    for (const s of [a.seen[0]!, b.seen[0]!]) {
      expect(s.url).toBe('http://pay.test/payments/p-1')
      expect(s.headers.get('x-org-id')).toBe('org-1')
      expect(s.headers.get('authorization')).toBe('Bearer t')
    }
    expect(() => createPayClient({ fetch: a.fetch })).toThrow(/base_url/)
  })

  it('withOrg keeps both spellings in step', async () => {
    const f = fake()
    await createPayClient({ baseUrl: 'http://pay.test', orgId: 'org-1', fetch: f.fetch }).withOrg('org-2').get('p-1')
    expect(f.seen[0]!.headers.get('x-org-id')).toBe('org-2')
  })

  it('charge sends snake_case, whichever spelling the caller used', async () => {
    const f = fake()
    const pay = createPayClient({ base_url: 'http://pay.test', fetch: f.fetch })
    await pay.charge({ customer_id: 'c-1', amount_cents: 5000, currency: 'USD', idempotency_key: 'k-1', invoice_id: 'inv-1' })
    await pay.charge({ customerId: 'c-1', amountCents: 5000, currency: 'USD', idempotencyKey: 'k-1', invoiceId: 'inv-1', simulateFailure: true, providerRef: 'pi_1', failureReason: 'x', status: 'failed' })
    expect(f.seen[0]!.body).toEqual({ customer_id: 'c-1', amount_cents: 5000, currency: 'USD', idempotency_key: 'k-1', invoice_id: 'inv-1' })
    expect(f.seen[1]!.body).toEqual({
      customer_id: 'c-1', amount_cents: 5000, currency: 'USD', idempotency_key: 'k-1', invoice_id: 'inv-1',
      simulate_failure: true, provider_ref: 'pi_1', failure_reason: 'x', status: 'failed',
    })
  })

  it('a payment is the snake_case record, with the old names readable and not enumerable', async () => {
    const f = fake()
    const p = await createPayClient({ base_url: 'http://pay.test', fetch: f.fetch }).get('p-1')
    expect(p.amount_cents).toBe(5000)
    expect(p.amountCents).toBe(5000)
    expect(p.shortId).toBe('py1')
    expect(p.customerName).toBe('Acme')
    expect(p.createdAt).toBe(7)
    expect(JSON.parse(JSON.stringify(p))).toEqual(ROW)
    expect(Object.keys(p).sort()).toEqual(Object.keys(ROW).sort())
  })

  it('list: customer_id and customerId both filter, and every row has its aliases', async () => {
    const f = fake(200, { payments: [ROW] })
    const pay = createPayClient({ base_url: 'http://pay.test', fetch: f.fetch })
    const rows = await pay.list({ customer_id: 'c-1', status: 'failed' })
    await pay.list({ customerId: 'c-1' })
    expect(f.seen[0]!.url).toBe('http://pay.test/payments?status=failed&customer=c-1')
    expect(f.seen[1]!.url).toBe('http://pay.test/payments?customer=c-1')
    expect(rows[0]!.invoiceId).toBeNull()
    expect(rows[0]!.providerRef).toBe('manual:py1')
  })

  it('errors carry status and code', async () => {
    const f = fake(404, { error: 'customer_not_found', message: 'nope' })
    await expect(createPayClient({ base_url: 'http://pay.test', fetch: f.fetch }).charge({ customer_id: 'x', amount_cents: 1, currency: 'USD', idempotency_key: 'k' }))
      .rejects.toMatchObject({ status: 404, code: 'customer_not_found', message: 'nope', name: 'PayError' })
    expect(new PayError(400, 'bad_amount')).toBeInstanceOf(Error)
  })

  it('linkInvoice PATCHes the invoice link and returns the payment with its aliases; list filters by invoice_id', async () => {
    const f = fake(200, { payment: { ...ROW, invoice_id: 'inv-1', invoice: { id: 'inv-1', number: 3 } } })
    const pay = createPayClient({ base_url: 'http://pay.test', fetch: f.fetch })
    const p = await pay.linkInvoice('p 1', 'inv-1')
    expect(f.seen[0]).toMatchObject({ url: 'http://pay.test/payments/p%201/invoice', method: 'PATCH', body: { invoice_id: 'inv-1' } })
    expect(p.invoiceId).toBe('inv-1')
    expect(p.invoice).toEqual({ id: 'inv-1', number: 3 })
    const g = fake(200, { payments: [] })
    await createPayClient({ base_url: 'http://pay.test', fetch: g.fetch }).list({ invoice_id: 'inv-1', status: 'succeeded' })
    expect(g.seen[0]!.url).toBe('http://pay.test/payments?status=succeeded&invoice_id=inv-1')
  })

  it('already_linked is a PayError with its status', async () => {
    const f = fake(409, { error: 'already_linked', message: 'linked' })
    await expect(createPayClient({ base_url: 'http://pay.test', fetch: f.fetch }).linkInvoice('p-1', 'inv-2')).rejects.toMatchObject({ status: 409, code: 'already_linked' })
  })
})
