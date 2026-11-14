import { Hono, type Context } from 'hono'
import { readFileSync } from 'node:fs'
import { serviceManifest } from '@baseworks/core/service'
import type { FoldBase } from '@baseworks/foldbase'
import { PROJECTIONS, POLICIES } from '@baseworks/pay/projections'
import { payRouter } from './routes/pay.js'
import { StoreError, createStore } from './store.js'

export async function registerDefinitions(fb: FoldBase): Promise<void> {
  for (const p of PROJECTIONS) await fb.putProjection(p.def)
  for (const p of POLICIES) await fb.putPolicy(p)
}

// Read once: the release is a build-time fact, and re-reading it per request
// would turn a manifest fetch into disk I/O.
const VERSION = (() => {
  try {
    return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as
      { version?: string }).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/** A store's refusal becomes its own status and code; anything else is a 500 that says nothing. */
const onError = (err: Error, c: Context) => {
  if (err instanceof StoreError) return c.json({ error: err.code, message: err.message }, err.status as never)
  const status = (err as { status?: number }).status
  if (typeof status === 'number' && status >= 400 && status < 600) return c.json({ error: (err as { code?: string }).code ?? 'error', message: err.message }, status as never)
  console.error(err)
  return c.json({ error: 'internal', message: 'Internal server error' }, 500)
}

/** pay-service = the payment-collection capability. `orgBaseUrl` = org-service
 *  (membership); `customersBaseUrl` = customers-service (customer resolution). */
export function createApp(fb: FoldBase, orgBaseUrl: string, customersBaseUrl: string): Hono {
  const store = createStore(fb)
  const app = new Hono()
  app.get('/healthz', (c) => c.json({ ok: true, service: 'pay-service' }))

  // The mounts (workspace ADR 0003):
  //
  //   /api   the API: what a gateway publishes at `/v1/pay`, replacing the
  //          prefix. Discovery and the contract are part of it.
  //   /      not published: `/healthz`.
  //
  // `/ui` (pages) and `/_` (service to service) are the other two; this
  // service has neither, so neither is mounted.

  // What this service is and what contract it speaks (ADR-042 §8). There is no
  // registry: a client asks each known base for this, and whatever does not
  // answer is not installed. Unauthenticated — it holds no secrets.
  const manifest = (c: Context) =>
    c.json(
      serviceManifest({
        name: 'pay',
        version: VERSION,
        // Moves only when the HTTP surface breaks callers, not every release.
        api_version: '1.0',
        openapi_url: '/openapi.yaml',
        capabilities: ['charges', 'idempotency', 'providers', 'org-scoped'],
      }),
    )

  // The contract itself, served from the repo file so document and code ship
  // together and cannot drift apart between releases.
  const contract = (c: Context) => {
    try {
      const spec = readFileSync(new URL('../openapi.yaml', import.meta.url), 'utf8')
      return c.body(spec, 200, { 'content-type': 'application/yaml; charset=utf-8' })
    } catch {
      return c.json({ error: 'spec not bundled with this build' }, 404)
    }
  }

  const router = payRouter(store, orgBaseUrl, customersBaseUrl)

  const api = new Hono()
  api.get('/.well-known/service', manifest)
  api.get('/openapi.yaml', contract)
  api.route('/', router)
  api.onError(onError)
  app.route('/api', api)

  // ── Until every direct caller names `/api` ──────────────────────────────
  // The API used to be mounted at the root, and before that under `/v1`. Both
  // stay for now: services given this service's bare address (stripe-service,
  // the published @baseworks/pay client) and a gateway that still strips
  // `/v1/pay` without adding `/api` land here. The same gates travel with the
  // routes.
  app.get('/.well-known/service', manifest)
  app.get('/openapi.yaml', contract)
  app.route('/', router)
  app.route('/v1', router)

  app.onError(onError)
  return app
}
