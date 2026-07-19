import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { createEnv } from '@baseworks/sdk'
import { createApp, registerDefinitions } from './app.js'

const env = createEnv()
const fb = env.service('foldbase')
await registerDefinitions(fb)

function resolveBase(name: string, gatewayPath: string): string {
  const N = name.toUpperCase()
  const url = process.env[`${N}_SERVICE_URL`] ?? process.env[`${N}_URL`] ??
    (process.env['BASEWORKS_GATEWAY'] ? `${process.env['BASEWORKS_GATEWAY'].replace(/\/$/, '')}${gatewayPath}` : undefined)
  if (!url) throw new Error(`${N}_SERVICE_URL not configured`)
  return url
}
const orgBaseUrl = resolveBase('org', '/org')
const customersBaseUrl = resolveBase('customers', '')

const root = new Hono()
root.use('*', logger())
root.route('/', createApp(fb, orgBaseUrl, customersBaseUrl))

const port = Number(env.var('PORT') ?? 3000)
serve({ fetch: root.fetch, port }, () => console.log(`pay-service listening on :${port}  (org PDP: ${orgBaseUrl})`))
