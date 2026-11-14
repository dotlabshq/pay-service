import { z } from 'zod'
import { defineAggregate } from '@baseworks/foldbase'

/**
 * Event catalog for pay-service — the **payment collection** capability. A payment
 * is a charge against a provider (`manual` = recorded out-of-band; `mock` = a
 * simulated gateway for local/testing). Real gateways (Stripe, …) plug in as more
 * providers later. MONEY IS INTEGER CENTS. Tenant = org id.
 *
 * Ingest is **idempotent** (like usage metering, ADR-011): a charge's stream id is
 * derived from the caller's `idempotency_key`, so retrying a charge never
 * double-charges. A charge resolves synchronously to `succeeded | failed`.
 *
 * Payload fields are snake_case (0.3.0); events written before are camelCase
 * (`customerId`, `amountCents`, `shortId`, …) and stay so in the log: foldbase reads
 * a snake_case path from a camelCase payload when the snake_case key is absent, so
 * the projection folds both. A release that writes snake_case cannot be rolled back.
 */

export const Provider = z.enum(['manual', 'mock', 'stripe'])
export type Provider = z.infer<typeof Provider>

export const PaymentStatus = z.enum(['succeeded', 'failed'])
export type PaymentStatus = z.infer<typeof PaymentStatus>

export const PaymentEvents = defineAggregate('payment', {
  PaymentCharged: z.object({
    customer_id: z.string().min(1),      // customers-service ref (resolved)
    customer_name: z.string(),           // snapshot for display
    amount_cents: z.number().int(),
    currency: z.string().length(3),
    invoice_id: z.string(),              // optional invoice-service ref ('' = none)
    provider: Provider,
    provider_ref: z.string(),            // the provider's own id for this charge
    status: PaymentStatus,
    failure_reason: z.string(),          // '' unless status = failed
    idempotency_key: z.string().min(1),  // caller idempotency key (unique per org)
    short_id: z.string().min(1),
    at: z.number().int(),
  }),
})
