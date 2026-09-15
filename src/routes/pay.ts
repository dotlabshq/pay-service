import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { createOrgClient, OrgError } from '@baseworks/org'
import { createCustomersClient, CustomersError } from '@baseworks/customers'
import { requireAuth } from '../lib/auth.js'
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

/** Payment routes. Auth: identity JWT + X-Org-Id, org membership via org-service.
 *  Charges resolve + snapshot the customer against customers-service. */
export function payRouter(store: Store, orgBaseUrl: string, customersBaseUrl: string) {
  const app = new Hono()
  app.use('*', requireAuth)
  app.use('*', async (c, next) => {
    // `X-Org-Id` may carry an id, a slug or a short id (ADR-042 §3), and the org
    // id is also the storage tenant — so the header is resolved before anything
    // is stored against it. Taken verbatim, `acme` and the org's real id would
    // be two separate tenants for one organization, and which one you saw would
    // depend on which client wrote last.
    const orgRef = c.req.header('X-Org-Id')
    if (!orgRef) return c.json({ error: 'org_required', message: 'Missing X-Org-Id — run `use <org>` first' }, 400)
    const bearer = c.req.header('Authorization')!.slice(7)
    // Service tokens (plane-signed, e.g. stripe-service reconciling a webhook) are
    // trusted callers: skip the per-user membership check and act on the given org.
    if ((c.get('auth') as { tokenType?: string } | undefined)?.tokenType === 'service') {
      // A service skips the membership check and therefore the resolution
      // above: it must name the org by its id.
      c.set('orgId' as never, orgRef as never); c.set('bearer' as never, bearer as never)
      return next()
    }
    const org = createOrgClient({ baseUrl: orgBaseUrl, token: bearer })
    try {
      const { role, via } = await org.effectiveRole(orgRef)
      if (role === 'none') return c.json({ error: 'forbidden', message: 'Not a member of this org' }, 403)
      c.set('orgId' as never, (via?.scopeId ?? orgRef) as never)
      c.set('bearer' as never, bearer as never)
    } catch (e) {
      if (e instanceof OrgError && e.status === 404) return c.json({ error: 'org_not_found', message: 'Active org does not exist — run `use <org>`' }, 404)
      return c.json({ error: 'authz_unavailable', message: (e as Error).message }, 502)
    }
    return next()
  })
  const orgOf = (c: { get: (k: string) => unknown }) => c.get('orgId') as string
  const bearerOf = (c: { get: (k: string) => unknown }) => c.get('bearer') as string
  const actorOf = (c: { get: (k: string) => unknown }) => (c.get('auth') as { userId: string }).userId

  async function resolveCustomer(orgId: string, bearer: string, ref: string): Promise<{ id: string; name: string }> {
    const customers = createCustomersClient({ baseUrl: customersBaseUrl, token: bearer, orgId })
    try {
      const cust = await customers.get(ref)
      return { id: cust.id, name: cust.name ?? '' }
    } catch (e) {
      if (e instanceof CustomersError && e.status === 404) throw new StoreError(404, 'customer_not_found', `Customer not found: ${ref}`)
      throw new StoreError(502, 'customers_unavailable', (e as Error).message)
    }
  }

  app.get('/v1/payments', async (c) => {
    const status = c.req.query('status'); const customer = c.req.query('customer')
    return c.json({ payments: await store.listPayments(orgOf(c), { ...(status ? { status } : {}), ...(customer ? { customerId: customer } : {}) }) })
  })
  app.get('/v1/payments/:ref', async (c) => {
    const payment = await store.getPayment(orgOf(c), c.req.param('ref'))
    return payment ? c.json({ payment }) : c.json({ error: 'not_found', message: 'Payment not found' }, 404)
  })
  app.post('/v1/payments', zValidator('json', Charge), async (c) => {
    const body = c.req.valid('json')
    // The record-only outcome fields (status/providerRef/failureReason) assert that
    // an EXTERNAL provider already collected money. Only a plane service (e.g.
    // stripe-service reconciling a webhook) may set them — otherwise a user could
    // forge a `succeeded` payment in the ledger.
    const isService = (c.get('auth') as { tokenType?: string } | undefined)?.tokenType === 'service'
    if (!isService && (body.status !== undefined || body.providerRef !== undefined || body.failureReason !== undefined)) {
      return c.json({ error: 'forbidden', message: 'status/providerRef/failureReason are service-only' }, 403)
    }
    const customer = await resolveCustomer(orgOf(c), bearerOf(c), body.customerId).catch(fail)
    const payment = await store.charge(orgOf(c), {
      customerId: customer.id, customerName: customer.name,
      amountCents: body.amountCents, currency: body.currency,
      ...(body.invoiceId ? { invoiceId: body.invoiceId } : {}),
      provider: body.provider ?? 'manual', idempotencyKey: body.idempotencyKey,
      ...(body.simulateFailure ? { simulateFailure: true } : {}),
      ...(isService && body.status ? { status: body.status } : {}),
      ...(isService && body.providerRef ? { providerRef: body.providerRef } : {}),
      ...(isService && body.failureReason ? { failureReason: body.failureReason } : {}),
    }, actorOf(c)).catch(fail)
    return c.json({ payment }, 201)
  })

  return app
}
