import type { Provider, PaymentStatus } from './events.js'
export type { Provider, PaymentStatus } from './events.js'

// ── read-model row (snake_case) ───────────────────────────────────────────────
export interface PaymentRow {
  id: string
  short_id: string
  customer_id: string
  customer_name: string
  amount_cents: number
  currency: string
  invoice_id: string
  provider: Provider
  provider_ref: string
  status: PaymentStatus
  failure_reason: string
  idempotency_key: string
  created_at: number
}

// ── REST DTO (camelCase) ──────────────────────────────────────────────────────
export interface Payment {
  id: string
  shortId: string
  customerId: string
  customerName: string | null
  amountCents: number
  currency: string
  invoiceId: string | null
  provider: Provider
  providerRef: string
  status: PaymentStatus
  failureReason: string | null
  idempotencyKey: string
  createdAt: number
}

export interface ChargeInput {
  /** Customer ref (id / short_id / external_id) — resolved via customers-service. */
  customerId: string
  amountCents: number
  currency: string
  /** Optional invoice-service ref this payment settles. */
  invoiceId?: string
  /** Provider to charge against (default `manual`). */
  provider?: Provider
  /** Idempotency key — unique per org; re-charging with the same key is a no-op. */
  idempotencyKey: string
  /** Test hook: force the provider to decline (records a `failed` payment). */
  simulateFailure?: boolean
  /** Record-only outcome for an EXTERNAL provider (e.g. stripe, confirmed off-band).
   *  When set, the provider isn't "run" — the given result is recorded as-is. */
  status?: PaymentStatus
  providerRef?: string
  failureReason?: string
}
