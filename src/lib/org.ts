import type { MiddlewareHandler } from 'hono'
import { signHs256Jwt } from '@baseworks/auth/jwt'
import { credentialKey } from '@baseworks/auth/principal'
import { can, type PermissionSet } from '@baseworks/core/permissions'
import { createOrgClient, permissionReader } from '@baseworks/org'

/**
 * What pay-service asks org-service, beyond "which organization is this".
 *
 * This service does not decide who may do what and names no role. It tells
 * org-service what its own actions ask for (`register()`, once at boot, as the
 * app `pay`), and for each request asks, **with the person's own token**,
 * which of those actions they may do in the organization. `can()` reads the
 * answer (workspace ADR 0003 §5a).
 *
 * Until the registration has succeeded org-service answers with no
 * permissions, so a person is refused everything. Closed, not open.
 *
 *   ORG_SERVICE_URL                  org-service's own address (not a gateway's)
 *   AUTH_URL                         auth-service's API, for this service's own token
 *   PAY_SERVICE_CLIENT_ID      default `pay`: the name it registers as
 *   PAY_SERVICE_CLIENT_SECRET  its secret at auth-service (AUTH_SERVICE_CLIENTS)
 *   PAY_PERMISSION_CACHE_SECONDS  how long an answer is kept; default 15
 */

/** The app pay-service is, to org-service's decision point. */
export const PAY_APP = 'pay'

/** What each action asks for. Registered at boot; org-service decides with it. */
export const PAY_ACTIONS = {
  // Listing and reading payments.
  'payment.read': { min_role: 'viewer', access: 'read' },
  // Charging: records money collected. Idempotent by key, but it writes.
  'payment.charge': { min_role: 'member', access: 'write' },
  // Saying which invoice a payment settles, when it was recorded before the invoice was known. Once.
  'payment.link_invoice': { min_role: 'member', access: 'write' },
} as const

export type PayAction = keyof typeof PAY_ACTIONS

export interface OrgAccess {
  /**
   * What this caller may do with this service's actions in one organization.
   * `credential` says whose answer it is (`credentialKey(principal)`): a
   * session and a read-only token of the same person must not share one.
   */
  permissions(bearer: string, orgId: string, credential: string): Promise<PermissionSet>
  /** Tell org-service what the actions ask for. Throws when it is refused. */
  register(): Promise<void>
  /** This service's own identity token, for the calls it makes as itself (registering with org and webhooks). */
  ownToken(): Promise<string | null>
}

type Env = Record<string, string | undefined>

export function orgAccess(baseUrl: string, env: Env = process.env, fetchImpl?: typeof fetch): OrgAccess {
  const ttl = Number(env['PAY_PERMISSION_CACHE_SECONDS'] ?? 15)
  const remembered = permissionReader({ ttl_seconds: Number.isFinite(ttl) ? ttl : 15 })
  const client = (token: string) => createOrgClient({ base_url: baseUrl, token, ...(fetchImpl ? { fetch: fetchImpl } : {}) })
  const doFetch = (...a: Parameters<typeof fetch>) => (fetchImpl ?? globalThis.fetch)(...a)

  /** This service's own identity, for the one call it makes as itself. */
  async function ownToken(): Promise<string | null> {
    const id = env['PAY_SERVICE_CLIENT_ID'] ?? PAY_APP
    const authUrl = (env['AUTH_URL'] ?? '').replace(/\/+$/, '')
    const secret = env['PAY_SERVICE_CLIENT_SECRET']
    if (authUrl && secret) {
      const res = await doFetch(`${authUrl}/service-token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: id, client_secret: secret, expires_in: 300 }),
      })
      const data = (await res.json().catch(() => ({}))) as { token?: string }
      return res.status === 200 && data.token ? data.token : null
    }
    // A realm still on the shared secret signs for itself, as every service
    // there does. It is the legacy path and proves nothing between services.
    const shared = env['JWT_SECRET']
    return shared ? signHs256Jwt({ sub: id, type: 'service' }, shared, 300) : null
  }

  return {
    permissions(bearer, orgId, credential) {
      return remembered.read(`${credential}\u0000${orgId}`, () =>
        client(bearer).permissions({ app: PAY_APP, scope_id: orgId }))
    },
    async register() {
      const token = await ownToken()
      if (!token) throw new Error('pay-service has no service identity')
      await client(token).registerApp({
        name: PAY_APP,
        origin: env['APP_PUBLIC_URL'] || 'pay-service',
        actions: PAY_ACTIONS,
      } as never)
    },
    ownToken,
  }
}

/**
 * The gate on one route: may this caller do `action` in the request's
 * organization? Runs after `requireAuth` and `requireOrg`.
 *
 * A service token is a plane caller acting as itself: `requireOrg` already let
 * it through without a membership, and there is no person to ask about. That
 * is unchanged here; which services may do what is not narrowed yet.
 */
export function permit(org: OrgAccess, action: PayAction): MiddlewareHandler {
  return async (c, next) => {
    if (c.get('org_role') === 'service') return next()
    const auth = c.get('auth') as { principal: Parameters<typeof credentialKey>[0] }
    let set: PermissionSet
    try {
      // The memory is the credential's, not the person's.
      set = await org.permissions(c.get('bearer'), c.get('org_id'), credentialKey(auth.principal))
    } catch (e) {
      // Cannot ask is not "yes".
      return c.json({ error: 'authz_unavailable', message: (e as Error).message }, 502)
    }
    if (!can(set, action)) {
      return c.json({ error: 'forbidden', message: `Missing permission ${action}`, permission: action }, 403)
    }
    return next()
  }
}

/**
 * Register the actions with org-service, retrying while it is not up yet (a
 * realm starts in no fixed order). Never throws and never blocks the boot.
 */
export async function registerWithOrg(access: OrgAccess, opts: { attempts?: number; delay_ms?: number; log?: (m: string) => void } = {}): Promise<boolean> {
  const attempts = opts.attempts ?? 10
  const log = opts.log ?? ((m) => console.log(m))
  let last = ''
  for (let i = 1; i <= attempts; i++) {
    try {
      await access.register()
      log(`pay-service: registered its actions with org-service (${Object.keys(PAY_ACTIONS).length})`)
      return true
    } catch (err) {
      last = err instanceof Error ? err.message : String(err)
    }
    if (i < attempts) await new Promise((r) => setTimeout(r, opts.delay_ms ?? 3_000))
  }
  log(`pay-service: NOT registered with org-service after ${attempts} attempts (${last}); people are refused until a later start succeeds`)
  return false
}
