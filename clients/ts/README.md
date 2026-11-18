# @baseworks/pay

Typed client, event catalog, projections, and CLI plugin for **pay-service** — the
per-org **payment-collection** capability. Contract-first, versioned with the service.

```bash
pnpm add @baseworks/pay
```

## Client

Everything is **org-scoped** (`X-Org-Id` + a realm token or a `bwt_` API token).
**Money is integer cents.** Every name is **snake_case** (0.3.0); the old
camelCase ones still work, see [Deprecated names](#deprecated-names).

```ts
import { createPayClient } from '@baseworks/pay'

const pay = createPayClient({
  base_url: process.env.PAY_SERVICE_URL!,
  token:    realmToken,
  org_id:   activeOrgId,
})

// charge a customer (customer_id is a customers-service ref — validated, name
// snapshotted). Idempotent by idempotency_key: re-sending returns the same payment.
const payment = await pay.charge({
  customer_id: 'acct-42',
  amount_cents: 5000,             // $50.00
  currency: 'USD',
  provider: 'manual',            // 'manual' | 'mock'
  idempotency_key: 'invoice-7-attempt-1',
  invoice_id: 'inv_123',         // optional — the invoice this settles
})
// → { status: 'succeeded', provider_ref: 'manual:…', amount_cents: 5000, … }

await pay.list({ status: 'succeeded' })
await pay.list({ customer_id: 'acct-42' })
await pay.get(payment.id)       // id, short_id or idempotency key; `.invoice` is the invoice it settles (1.1.0)
await pay.list({ invoice_id: 'inv_123' })

// payment recorded before its invoice was known: say which one, once (permission payment.link_invoice)
await pay.linkInvoice(payment.id, 'inv_123')   // same invoice again: no-op; another: PayError 409 already_linked
```

What a caller may do is decided by org-service: `payment.read` to list and get,
`payment.charge` to charge. Errors throw `PayError` (`.status`, `.code`):
`400 bad_amount`, `403 forbidden` (no permission; a read-only credential cannot
charge; `status`, `provider_ref` and `failure_reason` are a service's alone),
`404 customer_not_found`, `409 already_linked`, `502 authz_unavailable`. A declined charge is **not**
an error — it returns a payment with `status: 'failed'` and a `failure_reason`.

### Deprecated names

Kept until the last caller (stripe-service, `apps/*`) has moved; they will be removed.

| Where | Deprecated | Use |
|---|---|---|
| `createPayClient` options | `baseUrl`, `orgId` | `base_url`, `org_id` |
| `charge()` input | `customerId`, `amountCents`, `invoiceId`, `idempotencyKey`, `simulateFailure`, `providerRef`, `failureReason` | `customer_id`, `amount_cents`, `invoice_id`, `idempotency_key`, `simulate_failure`, `provider_ref`, `failure_reason` (`status`, `provider`, `currency` unchanged) |
| `list()` options | `customerId` | `customer_id` |
| A returned `Payment` | `shortId`, `customerId`, `customerName`, `amountCents`, `invoiceId`, `providerRef`, `failureReason`, `idempotencyKey`, `createdAt` | `short_id`, `customer_id`, `customer_name`, `amount_cents`, `invoice_id`, `provider_ref`, `failure_reason`, `idempotency_key`, `created_at` |

The old names on a returned payment are readable but not enumerable, so
`JSON.stringify` and equality see the snake_case record only. The old input
spelling is sent to the service as snake_case. The CLI and the GraphQL
`Payment` type keep their own names (`shortId`, `amountCents`, … in GraphQL).

## CLI plugin

```ts
import { buildPayCommand } from '@baseworks/pay/cli'

program.addCommand(buildPayCommand({ http, cliName: 'dtab' }))
// dtab payments | pay   ls (--status --customer) · charge · get
//   dtab payments charge --customer <ref> --amount 50.00 --key <id> [--provider mock] [--invoice <ref>] [--fail]
```

## MCP tools

`@baseworks/pay/mcp` is the tool set a server composes (`@baseworks/mcp`), over
the same client:

```ts
import { composeTools } from '@baseworks/mcp'
import { payTools } from '@baseworks/pay/mcp'

composeTools(payTools())   // ctx.clients.pay must be a PayClient built from the realm token
```

| Tool | Access | Permission | |
|---|---|---|---|
| `pay_list` | read | `payment.read` | payments, by `status` / `customer_id` |
| `pay_get` | read | `payment.read` | one payment by id, short id or idempotency key |
| `pay_charge` | write | `payment.charge` | record money collected (`manual`) or try a flow (`mock`) |

Not offered on purpose: the outcome fields of a charge (`status`, `provider_ref`,
`failure_reason`: a service's alone) and `simulate_failure`. `@baseworks/mcp` is
a dependency; `@modelcontextprotocol/sdk` is an optional peer.

## Service integration

```ts
import { PROJECTIONS, POLICIES } from '@baseworks/pay/projections'
import { PaymentEvents } from '@baseworks/pay/events'
```

Projection `payments` → `read_payments`, keyed by the payment stream id
(= `sha256(payment:<idempotency_key>)`) so a duplicate charge collapses to one row.
Tenant = org id. Payload fields are snake_case from 0.3.0; events written before
are camelCase and fold the same (foldbase 0.5.1+ reads a snake_case path from a
camelCase payload).

## See also

Service: `projects/pay-service` ·
[ADR-010](../../../../docs/decisions/010-driptab-erp-decomposition.md).
