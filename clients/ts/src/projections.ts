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
    customer_id: e.customer_id,
    customer_name: e.customer_name,
    amount_cents: e.amount_cents,
    currency: e.currency,
    invoice_id: e.invoice_id,
    provider: e.provider,
    provider_ref: e.provider_ref,
    status: e.status,
    failure_reason: e.failure_reason,
    idempotency_key: e.idempotency_key,
    short_id: e.short_id,
    created_at: e.at,
  })),
  // Only the link changes; every other column of the row stays.
  PaymentInvoiceLinked: on.PaymentInvoiceLinked.upsert((e) => ({
    invoice_id: e.invoice_id,
  })),
}))

export const PROJECTIONS = [readPayments] as const

export const POLICIES: PolicyDef[] = [{ name: 'payments', role: 'admin' }]
