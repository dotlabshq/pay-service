import { createHash } from 'node:crypto'
import { type FoldBase, FoldBaseError } from '@baseworks/foldbase'
import { PaymentEvents } from '@baseworks/pay/events'
import type { Payment, PaymentRow, Provider, PaymentStatus } from '@baseworks/pay'
import { generateShortId } from '@baseworks/core'
import type { EmitAudit } from '@baseworks/auth/principal'

/**
 * The payment-collection domain over foldbase. Per-org (tenant = org id). A charge
 * is an **idempotent append**: its stream id is derived from the caller's
 * idempotencyKey, so re-charging with the same key re-targets the same stream, the
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

const toPayment = (r: PaymentRow): Payment => ({
  id: r.id, shortId: r.short_id, customerId: r.customer_id, customerName: orNull(r.customer_name),
  amountCents: r.amount_cents, currency: r.currency, invoiceId: orNull(r.invoice_id),
  provider: r.provider, providerRef: r.provider_ref, status: r.status,
  failureReason: orNull(r.failure_reason), idempotencyKey: r.idempotency_key, createdAt: r.created_at,
})

/** Run a charge through a provider. Synchronous for the built-in providers:
 *  `manual` records money collected out-of-band; `mock` simulates a gateway.
 *  `simulateFailure` (a test hook) forces a decline. Real gateways plug in here. */
function runProvider(provider: Provider, shortId: string, simulateFailure: boolean): { status: PaymentStatus; providerRef: string; failureReason: string } {
  if (simulateFailure) return { status: 'failed', providerRef: `${provider}:${shortId}`, failureReason: 'card_declined' }
  return { status: 'succeeded', providerRef: `${provider}:${shortId}`, failureReason: '' }
}

export interface ChargeArgs {
  customerId: string
  customerName: string
  amountCents: number
  currency: string
  invoiceId?: string
  provider: Provider
  idempotencyKey: string
  simulateFailure?: boolean
  /** Record-only outcome for an external provider (stripe). Bypasses runProvider. */
  status?: PaymentStatus
  providerRef?: string
  failureReason?: string
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
  function paymentStreamId(idempotencyKey: string): string {
    return createHash('sha256').update(`payment:${idempotencyKey}`).digest('hex')
  }
  async function getPaymentById(orgId: string, id: string): Promise<Payment | null> {
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
  async function getPayment(orgId: string, ref: string): Promise<Payment | null> {
    const r = await paymentRowByRef(orgId, ref); return r ? toPayment(r) : null
  }
  async function listPayments(orgId: string, opts: { status?: string; customerId?: string } = {}): Promise<Payment[]> {
    const { q } = scoped(orgId)
    const where: Record<string, { eq: string }> = {}
    if (opts.status) where['status'] = { eq: opts.status }
    if (opts.customerId) where['customer_id'] = { eq: opts.customerId }
    const res = await q.query<PaymentRow>('payments', { ...(Object.keys(where).length ? { where } : {}), sort: ['-created_at'], limit: 1000 })
    return res.rows.map(toPayment)
  }
  /** Idempotent charge. A repeated idempotencyKey returns the existing payment. */
  async function charge(orgId: string, input: ChargeArgs, audit: Audit): Promise<Payment> {
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new StoreError(400, 'bad_amount', 'amountCents must be a positive integer')
    const id = paymentStreamId(input.idempotencyKey)
    const existing = await getPaymentById(orgId, id)
    if (existing) return existing
    const shortId = generateShortId()
    // External provider (e.g. stripe): the charge already happened off-band, so record
    // the supplied outcome as-is. Built-in providers "run" synchronously.
    const result = input.status
      ? { status: input.status, providerRef: input.providerRef ?? `${input.provider}:${shortId}`, failureReason: input.failureReason ?? '' }
      : runProvider(input.provider, shortId, input.simulateFailure ?? false)
    const { payments } = scoped(orgId)
    try {
      await payments.emit(id, 0, 'PaymentCharged', {
        customerId: input.customerId, customerName: input.customerName,
        amountCents: input.amountCents, currency: input.currency, invoiceId: input.invoiceId ?? '',
        provider: input.provider, providerRef: result.providerRef, status: result.status,
        failureReason: result.failureReason, idempotencyKey: input.idempotencyKey, shortId, at: Date.now(),
      }, audit)
    } catch (e) {
      // Concurrent charge with the same key → version-0 conflict → return the winner.
      if (!(e instanceof FoldBaseError && e.status === 409)) throw e
    }
    return (await getPaymentById(orgId, id))!
  }

  return { charge, listPayments, getPayment }
}
