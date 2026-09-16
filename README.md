# pay-service

The **payment-collection** capability service (ADR-010). Foldbase-backed, org-scoped
(tenant = org id). Membership via org-service; charges reference a customer, resolved
+ validated against customers-service.

- **Client / CLI**: [`@baseworks/pay`](./clients/ts) (npm).
- **Runtime**: Hono + `@baseworks/sdk` over the shared foldbase.

## Model

A **payment** is a charge against a **provider**:

- `manual` — money collected out-of-band; recorded as `succeeded`.
- `mock` — a simulated gateway for local/testing.
- Real gateways (Stripe, …) plug in as more providers later.

A charge resolves synchronously to `succeeded | failed`. Money is **integer cents**.

Ingest is **idempotent**: the payment stream id is `sha256(payment:<idempotencyKey>)`,
so re-charging with the same key returns the existing payment — never a double charge
(the same guarantee as usage metering, ADR-011).

## REST surface

`Authorization: Bearer <identity-jwt>` + `X-Org-Id: <org>`.

| Method | Path | |
|---|---|---|
| `GET` | `/payments` | list (`?status`, `?customer`) |
| `GET` | `/payments/:ref` | one payment (id / short_id / idempotency_key) |
| `POST` | `/payments` | charge a customer (resolves the customer, idempotent) |

## The org is resolved, not taken at its word

`X-Org-Id` may name an organization by id, slug or short id (ADR-042 §3). The
org id is also the storage tenant, and idempotency keys are unique *per tenant*,
so taking the header verbatim would let one organization's key collide with
nothing and charge twice.

The PDP answers with the scope it resolved, and that canonical id is what this
service stores against.

## An outcome is asserted by whoever collected it

`status`, `providerRef` and `failureReason` say that money already changed hands
somewhere else. Only a **service token** may set them. A person who could would
be writing a succeeded payment into the ledger without collecting anything, so
the console never sends them and the service refuses them.

## Env

`FOLDBASE_SERVICE_URL`, `ORG_SERVICE_URL`, `CUSTOMERS_SERVICE_URL`, `JWT_SECRET`,
`PORT` (default 3000).

## Run

Runs inside the local plane ([`infra/local`](../../infra/local)). Image via justfile:
`just build-docker <tag>` → `ghcr.io/dotlabshq/pay-service:<tag>`.

## Deferred

Refunds / partial refunds, async provider webhooks (a `pending` state), saved payment
methods, real gateway adapters. None change the model above.
