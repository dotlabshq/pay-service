import { defineProjection, type PolicyDef } from '@baseworks/foldbase'
import { PaymentEvents } from './events.js'

/**
 * Read model registered on boot (idempotent). Projection names have NO `read_`
 * prefix (foldbase adds it → table `read_payments`). The row is keyed by the payment
 * stream id (= the idempotency hash), so a duplicate charge collapses to one row.
 * Tenant = org id.
 */
export const readPayments = defineProjection('payments', PaymentEvents, (on) => ({
  PaymentCharged: on.PaymentCharged.upsert((e) => ({
    customer_id: e.customerId,
    customer_name: e.customerName,
    amount_cents: e.amountCents,
    currency: e.currency,
    invoice_id: e.invoiceId,
    provider: e.provider,
    provider_ref: e.providerRef,
    status: e.status,
    failure_reason: e.failureReason,
    idempotency_key: e.idempotencyKey,
    short_id: e.shortId,
    created_at: e.at,
  })),
}))

export const PROJECTIONS = [readPayments] as const

export const POLICIES: PolicyDef[] = [{ name: 'payments', role: 'admin' }]
