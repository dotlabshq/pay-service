# @baseworks/pay

Typed client, event catalog, projections, and CLI plugin for **pay-service** — the
per-org **payment-collection** capability. Contract-first, versioned with the service.

```bash
pnpm add @baseworks/pay
```

## Client

Everything is **org-scoped** (`X-Org-Id` + identity token). **Money is integer cents.**

```ts
import { createPayClient } from '@baseworks/pay'

const pay = createPayClient({
  baseUrl: process.env.PAY_SERVICE_URL!,
  token:   identityJwt,
  orgId:   activeOrgId,
})

// charge a customer (customerId is a customers-service ref — validated, name
// snapshotted). Idempotent by idempotencyKey: re-sending returns the same payment.
const payment = await pay.charge({
  customerId: 'acct-42',
  amountCents: 5000,             // $50.00
  currency: 'USD',
  provider: 'manual',           // 'manual' | 'mock'
  idempotencyKey: 'invoice-7-attempt-1',
  invoiceId: 'inv_123',         // optional — the invoice this settles
})
// → { status: 'succeeded', providerRef: 'manual:…', … }

await pay.list({ status: 'succeeded' })
await pay.list({ customerId: 'acct-42' })
await pay.get(payment.id)
```

Errors throw `PayError` (`.status`, `.code`): `400 bad_amount`,
`404 customer_not_found`. A declined charge is **not** an error — it returns a
payment with `status: 'failed'` and a `failureReason`.

## CLI plugin

```ts
import { buildPayCommand } from '@baseworks/pay/cli'

program.addCommand(buildPayCommand({ http, cliName: 'dtab' }))
// dtab payments | pay   ls (--status --customer) · charge · get
//   dtab payments charge --customer <ref> --amount 50.00 --key <id> [--provider mock] [--invoice <ref>] [--fail]
```

## Service integration

```ts
import { PROJECTIONS, POLICIES } from '@baseworks/pay/projections'
import { PaymentEvents } from '@baseworks/pay/events'
```

Projection `payments` → `read_payments`, keyed by the payment stream id
(= `sha256(payment:<idempotencyKey>)`) so a duplicate charge collapses to one row.
Tenant = org id.

## See also

Service: `projects/pay-service` ·
[ADR-010](../../../../docs/decisions/010-driptab-erp-decomposition.md).
