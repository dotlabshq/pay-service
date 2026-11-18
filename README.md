# pay-service

The **payment-collection** capability service (ADR-010). Foldbase-backed, org-scoped
(tenant = org id). Who may do what is org-service's to say (permissions); charges reference a customer, resolved
+ validated against customers-service.

- **Client / CLI / MCP tools**: [`@baseworks/pay`](./clients/ts) (npm).
- **Runtime**: Hono + `@baseworks/sdk` over the shared foldbase.

**In the local realm:** port 3011, published by the gateway at `/v1/pay`.
From the workspace root: `just start pay` · `just logs pay` · `just restart pay`.
See the workspace [README](../../README.md) for the whole map and
[AGENTS.md](../../AGENTS.md) for the rules every service here follows.

## Model

A **payment** is a charge against a **provider**:

- `manual` — money collected out-of-band; recorded as `succeeded`.
- `mock` — a simulated gateway for local/testing.
- `stripe` — the charge already happened off-band; the caller (stripe-service) supplies the outcome, which is recorded as given.

A charge resolves synchronously to `succeeded | failed`. Money is **integer cents**.

Ingest is **idempotent**: the payment stream id is `sha256(payment:<idempotency_key>)`,
so re-charging with the same key returns the existing payment — never a double charge
(the same guarantee as usage metering, ADR-011).

## Surfaces

The mounts follow workspace ADR 0003:

| Mount | What | Published |
|---|---|---|
| `/api` | the API | at `/v1/pay`; the gateway replaces the prefix |
| `/healthz` | liveness | never; internal network only |

`/ui` (pages) and `/_` (service to service) are the other two mounts; this
service has neither. The API is also still mounted at the **root and under
`/v1`**, as legacy aliases, for direct callers that have not moved to `/api`
(stripe-service, the published `@baseworks/pay` client, a gateway that strips
`/v1/pay` without adding `/api`). The same gates travel with them. They will be
removed.

All routes require `Authorization: Bearer <realm token or bwt_ API token>` +
`X-Org-Id: <org>` (an id, a slug or a short id).

| Method | Path (under `/api`) | Permission | |
|---|---|---|---|
| `GET` | `/payments` | `payment.read` | list (`?status`, `?customer_id` or `?customer`, `?invoice_id`) |
| `GET` | `/payments/:ref` | `payment.read` | one payment (id / short_id / idempotency_key), with its `invoice` embedded (1.1.0) |
| `POST` | `/payments` | `payment.charge` | charge a customer (resolves the customer, idempotent) |
| `PATCH` | `/payments/:ref/invoice` | `payment.link_invoice` | say which invoice a payment settles: once, idempotent, 409 `already_linked` (1.1.0) |
| `GET` | `/.well-known/service` · `/openapi.yaml` | none | as every service |

## Who may (workspace ADR 0004)

This service decides nothing by role. `requireAuth` (from `@baseworks/auth`)
proves who is calling and `requireOrg` (from `@baseworks/org`) resolves
`X-Org-Id` to the organization and checks membership. Then each route names the
**permission** it needs, and org-service says whether this caller has it.

- At boot the service registers its **manifest** with org-service
  (`POST /_/apps/register`, as the service `pay`), in the background, retrying
  while org-service is not up. Until that has succeeded nobody is allowed
  anything: closed, not open. If org-service cannot be asked the answer is
  `502 authz_unavailable`, never yes.
- The manifest's actions: `payment.read` (min role `viewer`, access `read`),
  `payment.charge` and `payment.link_invoice` (min role `member`, access `write`). A read-only credential
  (a read API token, a read agent, a read organization key) can read and never
  charge; org-service answers for the credential, not only for the role.
- A permission answer is remembered for `PAY_PERMISSION_CACHE_SECONDS` (15)
  under `credentialKey(principal)`: a person's session, the same person's API
  token and their agent never share an answer.
- A **service** token (stripe-service) is a realm caller acting as itself: it is
  not asked about, as in customers-service. Which services may do what is not
  narrowed yet (an open item of the realm).
- Customers are resolved against customers-service with the **realm token** this
  request ran on (`c.get('realm_token')`), never the raw `Authorization`
  header: a `bwt_` token does not travel past this service.
- Every emit carries the audit envelope: `auditOf(c, { org_id })`. The stored
  event's `actor` is `user:<id>`, `agent:<name>@<handle>`,
  `machine:<key>@<org>` or `service:<name>`, and `metadata.audit` says who, how
  (session, token, key), for whom, through which surface and for which request.

## The invoice a payment settles (1.1.0)

The pay record is the **single source** of the payment→invoice link: `invoice_id`
on the payment, set when it is charged or once afterwards with
`PATCH /payments/:ref/invoice` (event `PaymentInvoiceLinked`). The same invoice
again is a no-op; another one is `409 already_linked`. pay does not check that
the invoice exists when linking.

`GET /payments/:ref` shows the invoice: `invoice: null` when there is none, else
`{ id, number, source, external_refs, total_cents, currency, payment_status }`,
read from invoice-service (`GET /invoices/:ref`, with this request's realm token)
every time and never stored here. `source`, `external_refs` and `payment_status`
are null until invoice-service 1.1.0. If invoice-service cannot be read the
payment still answers, with `invoice: { id }` and `invoice_unavailable: true`.
The list does not embed invoices; filter it with `?invoice_id=`.

## An outcome is asserted by whoever collected it

`status`, `provider_ref` and `failure_reason` say that money already changed hands
somewhere else. Only a **service** principal may set them (403 `forbidden`
otherwise). A person, an agent or a key that could would be writing a succeeded
payment into the ledger without collecting anything, so the console never sends
them and the service refuses them.

## snake_case

The wire, the code and the stored event payloads are snake_case (workspace ADR
0003): `customer_id`, `amount_cents`, `invoice_id`, `idempotency_key`,
`simulate_failure`, `provider_ref`, `failure_reason`, `short_id`, `created_at`.
Answers are snake_case only. Requests are still **read in their old camelCase
spelling** (`customerId`, `amountCents`, …) so a caller that has not moved keeps
working; the snake_case name wins when both are sent. `GET /payments` filters by
`?customer_id=` and, as before, `?customer=`.

Events written before 0.3.0 are camelCase and stay so in the log. foldbase
(0.5.1+) reads a snake_case path from a camelCase payload when the snake_case
key is absent, so the projection folds both; a payment charged by an older
release is found, listed and idempotent exactly like a new one.

> **A release that writes snake_case cannot be rolled back.** An older
> pay-service reads camelCase payloads only, and the snake_case ones it would
> meet read as empty. Deploy order of the realm: foldbase → org → iam →
> auth → customers → **pay** (→ stripe).

## The org is resolved, not taken at its word

`X-Org-Id` may name an organization by id, slug or short id (ADR-042 §3). The
org id is also the storage tenant, and idempotency keys are unique *per tenant*,
so taking the header verbatim would let one organization's key collide with
nothing and charge twice. `requireOrg` asks org-service and the canonical id it
answers with is what this service stores against. A service names the org by its
id.

## Env

| Variable | Meaning |
|---|---|
| `FOLDBASE_SERVICE_URL`, `FOLDBASE_TOKEN` | the shared foldbase (injected at deploy) |
| `ORG_SERVICE_URL` | org-service's own address, not a gateway's: membership, permissions, registration |
| `CUSTOMERS_SERVICE_URL` | customers-service, to resolve the customer of a charge |
| `INVOICE_SERVICE_URL` | invoice-service, to show the invoice a payment settles (optional: unset, payments answer `invoice_unavailable`) |
| `AUTH_URL` | auth-service's API: accepts `bwt_` API tokens (the exchange) and issues this service's own token |
| `AUTH_JWKS_URI`, `AUTH_ISSUER`, `AUTH_AUDIENCE` | verify realm tokens; `JWT_SECRET` is the legacy shared secret, accepted while set |
| `PAY_SERVICE_CLIENT_ID` | the name it registers as and calls as; default `pay` |
| `PAY_SERVICE_CLIENT_SECRET` | its secret at auth-service; add `pay:<secret>` to `AUTH_SERVICE_CLIENTS` there |
| `PAY_PERMISSION_CACHE_SECONDS` | how long a permission answer is kept; default 15 |
| `APP_PUBLIC_URL` | the origin reported at registration; default `pay-service` |
| `PORT` | default 3000 |

## Run

From the workspace root: `just start pay` (see the workspace
[README](../../README.md)). The image is built from the monorepo root with
`Dockerfile.workspace`:
`podman build -f projects/pay-service/Dockerfile.workspace -t pay-service:<tag> .`
(it copies every workspace package the service and its client depend on,
including `@baseworks/mcp` and `@baseworks/webhooks`, which `@baseworks/customers`
needs). `just build-docker <tag>` in this repo builds the standalone image
`ghcr.io/dotlabshq/pay-service:<tag>`; the local cluster manifests in
`deploy/local` do not carry this service yet.

## Tests

`pnpm test` here runs the unit suite (a foldbase Go sibling per file, org-service
and customers-service stood in for) and the **realm e2e**
(`src/__tests__/e2e/`): real auth, iam, org, customers and pay in one process
over one foldbase, with a person's session, a `bwt_` API token, an agent, an
organization key and a service calling pay through the real exchange.

## Deferred

Refunds / partial refunds, async provider webhooks (a `pending` state), saved payment
methods, real gateway adapters. None change the model above.
