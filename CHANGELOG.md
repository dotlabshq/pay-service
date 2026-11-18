# Changelog

## 1.1.0 — pay-service and @baseworks/pay (clave #188)

Additive: no caller changes, no event history rewritten, old events fold as before.

- `GET /payments/:ref` embeds `invoice`: `null` (no invoice), or `{ id, number, source, external_refs, total_cents, currency, payment_status }` read from invoice-service's `GET /invoices/:ref` with the request's realm token. `source`, `external_refs` and `payment_status` are null while invoice-service is older than 1.1.0. If invoice-service cannot answer (down, not configured, 404, slow) the payment still answers, with `invoice: { id }` and `invoice_unavailable: true`. New optional env `INVOICE_SERVICE_URL`.
- `PATCH /payments/:ref/invoice` `{ invoice_id }`, new permission `payment.link_invoice` (min role `member`, access `write`): links the payment to an invoice **once**. The same invoice again changes nothing; another one is `409 already_linked`. The pay record is the single source of the payment→invoice link. Event `PaymentInvoiceLinked` (snake_case; a camelCase `invoiceId` payload folds the same).
- `GET /payments?invoice_id=` filter.
- `@baseworks/pay`: `linkInvoice(ref, invoice_id)`, `list({ invoice_id })`, types `PaymentInvoice` and `PaymentWithInvoice`, the `PaymentInvoiceLinked` event and projection.
- Deploy: the manifest gains an action; pay registers it at boot. Until then `payment.link_invoice` is refused to everyone. A release that writes the new event cannot be rolled back past 1.0.0's projection (an older pay ignores unknown events but would not show the link).

## 1.0.0 — the first major on the November 2026 realm

`/api` surface, org-service permissions (`payment.read`, `payment.charge`), audit envelope on every event, snake_case on the wire and in events, MCP tools (`@baseworks/pay/mcp`). See the README.
