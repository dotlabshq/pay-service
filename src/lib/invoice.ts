import type { PaymentInvoice } from '@baseworks/pay'

/**
 * Read the invoice a payment settles from invoice-service, with the request's own realm token (never the raw
 * Authorization header). Only `GET /invoices/:ref` is used, and only the fields it already had at 1.0; the ones
 * invoice 1.1.0 adds (`source`, `external_refs`, `payment_status`) are read when present and are null when not.
 *
 * Reading is best effort: the payment is pay's own record, and an invoice that cannot be read (service down,
 * not configured, 4xx/5xx, the invoice gone, a slow answer) never takes the payment down with it.
 *
 *   INVOICE_SERVICE_URL   invoice-service's own address. Unset: every payment answers `invoice_unavailable`.
 */
export type InvoiceSummary = PaymentInvoice | { id: string }

export async function readInvoice(
  baseUrl: string | undefined, realmToken: string, orgId: string, id: string, fetchImpl: typeof fetch = globalThis.fetch,
): Promise<{ invoice: InvoiceSummary; unavailable: boolean }> {
  const unavailable = { invoice: { id }, unavailable: true }
  if (!baseUrl) return unavailable
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/invoices/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${realmToken}`, 'X-Org-Id': orgId },
      signal: AbortSignal.timeout(4_000),
    })
    if (!res.ok) return unavailable
    const inv = ((await res.json()) as { invoice?: Record<string, unknown> }).invoice
    if (!inv || typeof inv !== 'object') return unavailable
    const num = inv['number']
    return {
      unavailable: false,
      invoice: {
        id: String(inv['id'] ?? id),
        number: typeof num === 'number' && num > 0 ? num : null,
        source: (inv['source'] as PaymentInvoice['source'] | undefined) ?? null,
        external_refs: (inv['external_refs'] as PaymentInvoice['external_refs'] | undefined) ?? null,
        total_cents: Number(inv['total_cents'] ?? 0),
        currency: String(inv['currency'] ?? ''),
        payment_status: (inv['payment_status'] as PaymentInvoice['payment_status'] | undefined) ?? null,
      },
    }
  } catch {
    return unavailable
  }
}
