import { z } from 'zod'
import { defineAggregate } from '@baseworks/foldbase'

/**
 * Event catalog for pay-service — the **payment collection** capability. A payment
 * is a charge against a provider (`manual` = recorded out-of-band; `mock` = a
 * simulated gateway for local/testing). Real gateways (Stripe, …) plug in as more
 * providers later. MONEY IS INTEGER CENTS. Tenant = org id.
 *
 * Ingest is **idempotent** (like usage metering, ADR-011): a charge's stream id is
 * derived from the caller's `idempotencyKey`, so retrying a charge never
 * double-charges. A charge resolves synchronously to `succeeded | failed`.
 */

export const Provider = z.enum(['manual', 'mock', 'stripe'])
export type Provider = z.infer<typeof Provider>

export const PaymentStatus = z.enum(['succeeded', 'failed'])
export type PaymentStatus = z.infer<typeof PaymentStatus>

export const PaymentEvents = defineAggregate('payment', {
  PaymentCharged: z.object({
    customerId: z.string().min(1),      // customers-service ref (resolved)
    customerName: z.string(),           // snapshot for display
    amountCents: z.number().int(),
    currency: z.string().length(3),
    invoiceId: z.string(),              // optional invoice-service ref ('' = none)
    provider: Provider,
    providerRef: z.string(),            // the provider's own id for this charge
    status: PaymentStatus,
    failureReason: z.string(),          // '' unless status = failed
    idempotencyKey: z.string().min(1),  // caller idempotency key (unique per org)
    shortId: z.string().min(1),
    at: z.number().int(),
  }),
})
