import { Hono, type Context } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { requireOrg } from '@baseworks/org/hono'
import { createCustomersClient, CustomersError } from '@baseworks/customers'
import { auditOf, requireAuth } from '../lib/auth.js'
import { permit, type OrgAccess } from '../lib/org.js'
import { readInvoice } from '../lib/invoice.js'
import type { PaymentFields } from '@baseworks/pay'
import { StoreError, type Store } from '../store.js'

const Charge = z.object({
  customer_id: z.string().min(1),
  amount_cents: z.number().int().positive(),
  currency: z.string().length(3),
  invoice_id: z.string().min(1).optional(),
  provider: z.enum(['manual', 'mock', 'stripe']).optional(),
  idempotency_key: z.string().min(1),
  simulate_failure: z.boolean().optional(),
  status: z.enum(['succeeded', 'failed']).optional(),
  provider_ref: z.string().optional(),
  failure_reason: z.string().optional(),
})

/**
 * The wire is snake_case (ADR 0003). Until 0.3.0 this service spoke camelCase,
 * and callers that still do (an older @baseworks/pay, stripe-service on it) are
 * read the way they meant: the old names are renamed on the way in. Answers are
 * snake_case only. To be removed once no caller sends them.
 */
const LinkInvoice = z.object({ invoice_id: z.string().min(1) })

const OLD_NAMES: Record<string, string> = {
  customerId: 'customer_id', amountCents: 'amount_cents', invoiceId: 'invoice_id', idempotencyKey: 'idempotency_key',
  simulateFailure: 'simulate_failure', providerRef: 'provider_ref', failureReason: 'failure_reason',
}
function renamed(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    const key = OLD_NAMES[k] ?? k
    if (key in out && key !== k) continue // the new name wins when both are sent
    out[key] = v
  }
  return out
}
const snakeBody = <T extends z.ZodTypeAny>(schema: T) => zValidator('json', z.preprocess(renamed, schema) as unknown as T)

function fail(err: unknown): never {
  if (err instanceof StoreError) throw err
  throw new StoreError(500, 'internal', (err as Error).message)
}

/**
 * Payment routes. They are the API: app.ts mounts them under `/api`, and a
 * gateway publishes that at `/v1/pay` by replacing the prefix (workspace ADR
 * 0003), so the service never encodes where it is published.
 *
 * Every request is:
 *   1. authenticated (`requireAuth`: a realm JWT, or an API token exchanged
 *      for one), then
 *   2. bound to an org via `X-Org-Id`, resolved and checked against
 *      org-service by `requireOrg`; the org id is the foldbase tenant. Then
 *   3. allowed or refused by permission: org-service says which of this
 *      service's actions the caller may do there, and the route names the one
 *      it needs. No role is named here.
 * Charges resolve and snapshot the customer against customers-service, with
 * the realm token this request ran on, never the raw Authorization header.
 */
export function payRouter(store: Store, orgBaseUrl: string, customersBaseUrl: string, org: OrgAccess, invoiceBaseUrl?: string) {
  const app = new Hono()
  app.use('*', requireAuth)
  app.use('*', requireOrg({ base_url: orgBaseUrl }))

  const orgOf = (c: { get: (k: string) => unknown }) => c.get('org_id') as string

  async function resolveCustomer(orgId: string, realmToken: string, ref: string): Promise<{ id: string; name: string }> {
    const customers = createCustomersClient({ base_url: customersBaseUrl, token: realmToken, org_id: orgId })
    try {
      const cust = await customers.get(ref)
      return { id: cust.id, name: cust.name ?? '' }
    } catch (e) {
      if (e instanceof CustomersError && e.status === 404) throw new StoreError(404, 'customer_not_found', `Customer not found: ${ref}`)
      throw new StoreError(502, 'customers_unavailable', (e as Error).message)
    }
  }

  /** The payment with the invoice it settles, read from invoice-service with this request's realm token. */
  async function withInvoice(c: Context, payment: PaymentFields) {
    if (!payment.invoice_id) return { ...payment, invoice: null }
    const read = await readInvoice(invoiceBaseUrl, c.get('realm_token'), orgOf(c), payment.invoice_id)
    return { ...payment, invoice: read.invoice, ...(read.unavailable ? { invoice_unavailable: true } : {}) }
  }

  app.get('/payments', permit(org, 'payment.read'), async (c) => {
    const status = c.req.query('status'); const customer = c.req.query('customer_id') ?? c.req.query('customer')
    const invoice = c.req.query('invoice_id')
    return c.json({ payments: await store.listPayments(orgOf(c), { ...(status ? { status } : {}), ...(customer ? { customer_id: customer } : {}), ...(invoice ? { invoice_id: invoice } : {}) }) })
  })
  app.get('/payments/:ref', permit(org, 'payment.read'), async (c) => {
    const payment = await store.getPayment(orgOf(c), c.req.param('ref'))
    if (!payment) return c.json({ error: 'not_found', message: 'Payment not found' }, 404)
    return c.json({ payment: await withInvoice(c, payment) })
  })
  // Say which invoice a payment settles: once, idempotent for the same invoice, 409 `already_linked` for another.
  app.patch('/payments/:ref/invoice', permit(org, 'payment.link_invoice'), snakeBody(LinkInvoice), async (c) => {
    const payment = await store.linkInvoice(orgOf(c), c.req.param('ref'), c.req.valid('json').invoice_id, auditOf(c, { org_id: orgOf(c) })).catch(fail)
    return c.json({ payment: await withInvoice(c, payment) })
  })
  app.post('/payments', permit(org, 'payment.charge'), snakeBody(Charge), async (c) => {
    const body = c.req.valid('json')
    // The record-only outcome fields (status, provider_ref, failure_reason) assert that
    // an EXTERNAL provider already collected money. Only a realm service (e.g.
    // stripe-service reconciling a webhook) may set them — otherwise a user, an
    // agent or a key could forge a `succeeded` payment in the ledger.
    const isService = c.get('principal').kind === 'service'
    if (!isService && (body.status !== undefined || body.provider_ref !== undefined || body.failure_reason !== undefined)) {
      return c.json({ error: 'forbidden', message: 'status/provider_ref/failure_reason are service-only' }, 403)
    }
    const customer = await resolveCustomer(orgOf(c), c.get('realm_token'), body.customer_id).catch(fail)
    const payment = await store.charge(orgOf(c), {
      customer_id: customer.id, customer_name: customer.name,
      amount_cents: body.amount_cents, currency: body.currency,
      ...(body.invoice_id ? { invoice_id: body.invoice_id } : {}),
      provider: body.provider ?? 'manual', idempotency_key: body.idempotency_key,
      ...(body.simulate_failure ? { simulate_failure: true } : {}),
      ...(isService && body.status ? { status: body.status } : {}),
      ...(isService && body.provider_ref ? { provider_ref: body.provider_ref } : {}),
      ...(isService && body.failure_reason ? { failure_reason: body.failure_reason } : {}),
    }, auditOf(c, { org_id: orgOf(c) })).catch(fail)
    return c.json({ payment }, 201)
  })

  return app
}
