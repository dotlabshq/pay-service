import { createHash } from 'node:crypto'
import { type FoldBase, FoldBaseError } from '@baseworks/foldbase'
import { PaymentEvents } from '@baseworks/pay/events'
import type { PaymentFields, PaymentRow, Provider, PaymentStatus } from '@baseworks/pay'
import { generateShortId } from '@baseworks/core'
import type { EmitAudit } from '@baseworks/auth/principal'

/**
 * The payment-collection domain over foldbase. Per-org (tenant = org id). A charge
 * is an **idempotent append**: its stream id is derived from the caller's
 * idempotency_key, so re-charging with the same key re-targets the same stream, the
 * version-0 append conflicts, and the existing payment is returned (never a double
 * charge). A charge resolves synchronously against a provider. Money = integer cents.
 */

/**
 * Who caused a write, and the request it belongs to: `auditOf(c, { org_id })`
 * from `@baseworks/auth/hono` in a route. Every store function that writes
 * takes one; none invents an actor (workspace ADR 0004 §6).
 */
export type Audit = EmitAudit

export class StoreError extends Error {
  constructor(readonly status: number, readonly code: string, message?: string) {
    super(message ?? code); this.name = 'StoreError'
  }
}

const orNull = (s: string): string | null => (s === '' ? null : s)

const toPayment = (r: PaymentRow): PaymentFields => ({
  id: r.id, short_id: r.short_id, customer_id: r.customer_id, customer_name: orNull(r.customer_name),
  amount_cents: r.amount_cents, currency: r.currency, invoice_id: orNull(r.invoice_id),
  provider: r.provider, provider_ref: r.provider_ref, status: r.status,
  failure_reason: orNull(r.failure_reason), idempotency_key: r.idempotency_key, created_at: r.created_at,
})

/** Run a charge through a provider. Synchronous for the built-in providers:
 *  `manual` records money collected out-of-band; `mock` simulates a gateway.
 *  `simulateFailure` (a test hook) forces a decline. Real gateways plug in here. */
function runProvider(provider: Provider, shortId: string, simulateFailure: boolean): { status: PaymentStatus; provider_ref: string; failure_reason: string } {
  if (simulateFailure) return { status: 'failed', provider_ref: `${provider}:${shortId}`, failure_reason: 'card_declined' }
  return { status: 'succeeded', provider_ref: `${provider}:${shortId}`, failure_reason: '' }
}

export interface ChargeArgs {
  customer_id: string
  customer_name: string
  amount_cents: number
  currency: string
  invoice_id?: string
  provider: Provider
  idempotency_key: string
  simulate_failure?: boolean
  /** Record-only outcome for an external provider (stripe). Bypasses runProvider. */
  status?: PaymentStatus
  provider_ref?: string
  failure_reason?: string
}

export type Store = ReturnType<typeof createStore>

export function createStore(fb: FoldBase) {
  const scoped = (orgId: string) => {
    const t = fb.withTenant(orgId)
    return {
      q: t.withAuth({ uid: 'pay-service', role: 'admin' }),
      payments: t.catalog(PaymentEvents),
    }
  }

  /** Deterministic stream id from the idempotency key → idempotent charge. */
  function paymentStreamId(idempotency_key: string): string {
    return createHash('sha256').update(`payment:${idempotency_key}`).digest('hex')
  }
  async function getPaymentById(orgId: string, id: string): Promise<PaymentFields | null> {
    const { q } = scoped(orgId)
    const res = await q.query<PaymentRow>('payments', { where: { id: { eq: id } }, limit: 1 })
    return res.rows[0] ? toPayment(res.rows[0]) : null
  }
  async function paymentRowByRef(orgId: string, ref: string): Promise<PaymentRow | null> {
    const { q } = scoped(orgId)
    for (const field of ['id', 'short_id', 'idempotency_key'] as const) {
      const res = await q.query<PaymentRow>('payments', { where: { [field]: { eq: ref } }, limit: 1 })
      if (res.rows[0]) return res.rows[0]
    }
    return null
  }
  async function getPayment(orgId: string, ref: string): Promise<PaymentFields | null> {
    const r = await paymentRowByRef(orgId, ref); return r ? toPayment(r) : null
  }
  async function listPayments(orgId: string, opts: { status?: string; customer_id?: string; invoice_id?: string } = {}): Promise<PaymentFields[]> {
    const { q } = scoped(orgId)
    const where: Record<string, { eq: string }> = {}
    if (opts.status) where['status'] = { eq: opts.status }
    if (opts.customer_id) where['customer_id'] = { eq: opts.customer_id }
    if (opts.invoice_id) where['invoice_id'] = { eq: opts.invoice_id }
    const res = await q.query<PaymentRow>('payments', { ...(Object.keys(where).length ? { where } : {}), sort: ['-created_at'], limit: 1000 })
    return res.rows.map(toPayment)
  }
  /** Idempotent charge. A repeated idempotency_key returns the existing payment. */
  async function charge(orgId: string, input: ChargeArgs, audit: Audit): Promise<PaymentFields> {
    if (!Number.isInteger(input.amount_cents) || input.amount_cents <= 0) throw new StoreError(400, 'bad_amount', 'amount_cents must be a positive integer')
    const id = paymentStreamId(input.idempotency_key)
    const existing = await getPaymentById(orgId, id)
    if (existing) return existing
    const shortId = generateShortId()
    // External provider (e.g. stripe): the charge already happened off-band, so record
    // the supplied outcome as-is. Built-in providers "run" synchronously.
    const result = input.status
      ? { status: input.status, provider_ref: input.provider_ref ?? `${input.provider}:${shortId}`, failure_reason: input.failure_reason ?? '' }
      : runProvider(input.provider, shortId, input.simulate_failure ?? false)
    const { payments } = scoped(orgId)
    try {
      await payments.emit(id, 0, 'PaymentCharged', {
        customer_id: input.customer_id, customer_name: input.customer_name,
        amount_cents: input.amount_cents, currency: input.currency, invoice_id: input.invoice_id ?? '',
        provider: input.provider, provider_ref: result.provider_ref, status: result.status,
        failure_reason: result.failure_reason, idempotency_key: input.idempotency_key, short_id: shortId, at: Date.now(),
      }, audit)
    } catch (e) {
      // Concurrent charge with the same key → version-0 conflict → return the winner.
      if (!(e instanceof FoldBaseError && e.status === 409)) throw e
    }
    return (await getPaymentById(orgId, id))!
  }

  /**
   * Say which invoice a payment settles. The pay record is the one source of the link: it is written once, here.
   * The same invoice again changes nothing; a different one is `already_linked`. A payment charged with an
   * `invoice_id` is linked from the start.
   */
  async function linkInvoice(orgId: string, ref: string, invoice_id: string, audit: Audit): Promise<PaymentFields> {
    const { q, payments } = scoped(orgId)
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = await paymentRowByRef(orgId, ref)
      if (!row) throw new StoreError(404, 'not_found', 'Payment not found')
      if (row.invoice_id) {
        if (row.invoice_id === invoice_id) return toPayment(row)
        throw new StoreError(409, 'already_linked', `Payment is already linked to invoice ${row.invoice_id}`)
      }
      const { version } = await q.streamVersion(row.id)
      try {
        await payments.emit(row.id, version, 'PaymentInvoiceLinked', { invoice_id, at: Date.now() }, audit)
      } catch (e) {
        if (e instanceof FoldBaseError && e.status === 409) continue // changed meanwhile: read it again and decide
        throw e
      }
      return (await getPaymentById(orgId, row.id))!
    }
    throw new StoreError(409, 'conflict', 'Payment changed concurrently — retry')
  }

  return { charge, listPayments, getPayment, linkInvoice }
}
