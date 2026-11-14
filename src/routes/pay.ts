import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { requireOrg } from '@baseworks/org/hono'
import { createCustomersClient, CustomersError } from '@baseworks/customers'
import { auditOf, requireAuth } from '../lib/auth.js'
import { permit, type OrgAccess } from '../lib/org.js'
import { StoreError, type Store } from '../store.js'

const Charge = z.object({
  customerId: z.string().min(1),
  amountCents: z.number().int().positive(),
  currency: z.string().length(3),
  invoiceId: z.string().min(1).optional(),
  provider: z.enum(['manual', 'mock', 'stripe']).optional(),
  idempotencyKey: z.string().min(1),
  simulateFailure: z.boolean().optional(),
  status: z.enum(['succeeded', 'failed']).optional(),
  providerRef: z.string().optional(),
  failureReason: z.string().optional(),
})

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
export function payRouter(store: Store, orgBaseUrl: string, customersBaseUrl: string, org: OrgAccess) {
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

  app.get('/payments', permit(org, 'payment.read'), async (c) => {
    const status = c.req.query('status'); const customer = c.req.query('customer')
    return c.json({ payments: await store.listPayments(orgOf(c), { ...(status ? { status } : {}), ...(customer ? { customerId: customer } : {}) }) })
  })
  app.get('/payments/:ref', permit(org, 'payment.read'), async (c) => {
    const payment = await store.getPayment(orgOf(c), c.req.param('ref'))
    return payment ? c.json({ payment }) : c.json({ error: 'not_found', message: 'Payment not found' }, 404)
  })
  app.post('/payments', permit(org, 'payment.charge'), zValidator('json', Charge), async (c) => {
    const body = c.req.valid('json')
    // The record-only outcome fields (status/providerRef/failureReason) assert that
    // an EXTERNAL provider already collected money. Only a realm service (e.g.
    // stripe-service reconciling a webhook) may set them — otherwise a user, an
    // agent or a key could forge a `succeeded` payment in the ledger.
    const isService = c.get('principal').kind === 'service'
    if (!isService && (body.status !== undefined || body.providerRef !== undefined || body.failureReason !== undefined)) {
      return c.json({ error: 'forbidden', message: 'status/providerRef/failureReason are service-only' }, 403)
    }
    const customer = await resolveCustomer(orgOf(c), c.get('realm_token'), body.customerId).catch(fail)
    const payment = await store.charge(orgOf(c), {
      customerId: customer.id, customerName: customer.name,
      amountCents: body.amountCents, currency: body.currency,
      ...(body.invoiceId ? { invoiceId: body.invoiceId } : {}),
      provider: body.provider ?? 'manual', idempotencyKey: body.idempotencyKey,
      ...(body.simulateFailure ? { simulateFailure: true } : {}),
      ...(isService && body.status ? { status: body.status } : {}),
      ...(isService && body.providerRef ? { providerRef: body.providerRef } : {}),
      ...(isService && body.failureReason ? { failureReason: body.failureReason } : {}),
    }, auditOf(c, { org_id: orgOf(c) })).catch(fail)
    return c.json({ payment }, 201)
  })

  return app
}
