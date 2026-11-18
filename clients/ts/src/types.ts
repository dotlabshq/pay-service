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

// ── REST DTO (snake_case, like the row) ───────────────────────────────────────
// The wire was camelCase before service 0.3.0 / client 0.3.0. The old names are
// still on the objects this client returns, as deprecated aliases (not
// enumerable, so JSON and equality see the snake_case record only).
export interface PaymentFields {
  id: string
  short_id: string
  customer_id: string
  customer_name: string | null
  amount_cents: number
  currency: string
  invoice_id: string | null
  provider: Provider
  provider_ref: string
  status: PaymentStatus
  failure_reason: string | null
  idempotency_key: string
  created_at: number
}

/** The camelCase names a payment had before 0.3.0. Read the snake_case ones. */
export interface PaymentAliases {
  /** @deprecated Read `short_id`. */
  readonly shortId: string
  /** @deprecated Read `customer_id`. */
  readonly customerId: string
  /** @deprecated Read `customer_name`. */
  readonly customerName: string | null
  /** @deprecated Read `amount_cents`. */
  readonly amountCents: number
  /** @deprecated Read `invoice_id`. */
  readonly invoiceId: string | null
  /** @deprecated Read `provider_ref`. */
  readonly providerRef: string
  /** @deprecated Read `failure_reason`. */
  readonly failureReason: string | null
  /** @deprecated Read `idempotency_key`. */
  readonly idempotencyKey: string
  /** @deprecated Read `created_at`. */
  readonly createdAt: number
}

/**
 * The invoice a payment settles, as invoice-service shows it now (1.1.0). Read, never stored here.
 * `source`, `external_refs` and `payment_status` are null when the invoice-service in use does not answer them yet.
 */
export interface PaymentInvoice {
  id: string
  number: number | null
  source: 'local' | 'stripe' | 'manual' | null
  external_refs: Array<{ system: string; id: string; number?: string; url?: string; pdf_url?: string; account_id?: string; livemode?: boolean }> | null
  total_cents: number
  currency: string
  payment_status: 'unpaid' | 'partially_paid' | 'paid' | 'not_due' | null
}

/** What `GET /payments/:ref` adds (1.1.0): the invoice, or `{ id }` and `invoice_unavailable` when invoice-service could not answer. */
export interface PaymentWithInvoice {
  invoice?: PaymentInvoice | { id: string } | null
  invoice_unavailable?: boolean
}

export type Payment = PaymentFields & PaymentAliases & PaymentWithInvoice

export interface ChargeFields {
  /** Customer ref (id / short_id / external_id) — resolved via customers-service. */
  customer_id: string
  amount_cents: number
  currency: string
  /** Optional invoice-service ref this payment settles. */
  invoice_id?: string
  /** Provider to charge against (default `manual`). */
  provider?: Provider
  /** Idempotency key — unique per org; re-charging with the same key is a no-op. */
  idempotency_key: string
  /** Test hook: force the provider to decline (records a `failed` payment). */
  simulate_failure?: boolean
  /** Record-only outcome for an EXTERNAL provider (e.g. stripe, confirmed off-band).
   *  When set, the provider isn't "run" — the given result is recorded as-is.
   *  Only a realm service may set `status`, `provider_ref` and `failure_reason`. */
  status?: PaymentStatus
  provider_ref?: string
  failure_reason?: string
}

/** @deprecated The camelCase spelling of `ChargeFields`; still accepted until the last caller has moved. */
export interface ChargeFieldsDeprecated {
  customerId: string
  amountCents: number
  currency: string
  invoiceId?: string
  provider?: Provider
  idempotencyKey: string
  simulateFailure?: boolean
  status?: PaymentStatus
  providerRef?: string
  failureReason?: string
}

export type ChargeInput = ChargeFields | ChargeFieldsDeprecated

const CHARGE_NAMES: Record<string, keyof ChargeFields> = {
  customerId: 'customer_id', amountCents: 'amount_cents', invoiceId: 'invoice_id', idempotencyKey: 'idempotency_key',
  simulateFailure: 'simulate_failure', providerRef: 'provider_ref', failureReason: 'failure_reason',
}

/** A charge as the wire spells it: snake_case, whichever spelling the caller used (snake_case wins when both). */
export function chargeBody(input: ChargeInput): ChargeFields {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(input)) {
    const key = CHARGE_NAMES[k] ?? k
    if (key !== k && key in out) continue
    out[key] = v
  }
  return out as unknown as ChargeFields
}

/** What a payment looks like to a caller that still reads the old names. */
export function withAliases(p: PaymentFields): Payment {
  const o = { ...p } as Payment
  const alias: Array<[keyof PaymentAliases, keyof PaymentFields]> = [
    ['shortId', 'short_id'], ['customerId', 'customer_id'], ['customerName', 'customer_name'], ['amountCents', 'amount_cents'],
    ['invoiceId', 'invoice_id'], ['providerRef', 'provider_ref'], ['failureReason', 'failure_reason'],
    ['idempotencyKey', 'idempotency_key'], ['createdAt', 'created_at'],
  ]
  for (const [old, name] of alias) Object.defineProperty(o, old, { value: p[name], enumerable: false })
  return o
}
