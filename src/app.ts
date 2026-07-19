import { Hono } from 'hono'
import type { FoldBase } from '@baseworks/foldbase'
import { PROJECTIONS, POLICIES } from '@baseworks/pay/projections'
import { payRouter } from './routes/pay.js'
import { StoreError, createStore } from './store.js'

export async function registerDefinitions(fb: FoldBase): Promise<void> {
  for (const p of PROJECTIONS) await fb.putProjection(p.def)
  for (const p of POLICIES) await fb.putPolicy(p)
}

/** pay-service = the payment-collection capability. `orgBaseUrl` = org-service
 *  (membership); `customersBaseUrl` = customers-service (customer resolution). */
export function createApp(fb: FoldBase, orgBaseUrl: string, customersBaseUrl: string): Hono {
  const store = createStore(fb)
  const app = new Hono()
  app.get('/healthz', (c) => c.json({ ok: true, service: 'pay-service' }))
  app.route('/', payRouter(store, orgBaseUrl, customersBaseUrl))
  app.onError((err, c) => {
    if (err instanceof StoreError) return c.json({ error: err.code, message: err.message }, err.status as never)
    const status = (err as { status?: number }).status
    if (typeof status === 'number' && status >= 400 && status < 600) return c.json({ error: (err as { code?: string }).code ?? 'error', message: err.message }, status as never)
    console.error(err)
    return c.json({ error: 'internal', message: 'Internal server error' }, 500)
  })
  return app
}
