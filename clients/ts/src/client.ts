import { chargeBody, withAliases, type Payment, type PaymentFields, type ChargeInput } from './types.js'

export type {
  Payment, PaymentFields, PaymentAliases, Provider, PaymentStatus, PaymentRow, ChargeInput, ChargeFields, ChargeFieldsDeprecated,
} from './types.js'

export interface PayClientOptions {
  /** Base URL of pay-service (e.g. PAY_SERVICE_URL). */
  base_url?: string
  /** Bearer token — the caller's identity JWT. */
  token?: string
  /** Active org id — sent as X-Org-Id (pay is org-scoped, tenant = org). */
  org_id?: string
  /** @deprecated Read `base_url`. Accepted until the last caller has moved. */
  baseUrl?: string
  /** @deprecated Read `org_id`. Accepted until the last caller has moved. */
  orgId?: string
  fetch?: typeof fetch
}

/** Thrown on any non-2xx response from pay-service. */
export class PayError extends Error {
  constructor(readonly status: number, readonly code: string, message?: string) {
    super(message ?? code)
    this.name = 'PayError'
  }
}

export interface HttpClient {
  api<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<T>
  get<T>(path: string, headers?: Record<string, string>): Promise<T>
  post<T>(path: string, body: unknown, headers?: Record<string, string>): Promise<T>
  patch<T>(path: string, body: unknown, headers?: Record<string, string>): Promise<T>
  del<T>(path: string, headers?: Record<string, string>): Promise<T>
}

/** Typed HTTP client for pay-service (payment collection). */
/**
 * Paths here are the service's own — `/payments`, not `/v1/payments`. A gateway
 * publishes the service at `/v1/<name>` and strips that prefix (ADR-042 §4), so
 * the client says what the service serves and `baseUrl` says where it is.
 */
export class PayClient {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  constructor(private readonly opts: PayClientOptions) {
    const base = opts.base_url ?? opts.baseUrl
    if (!base) throw new Error('PayClient needs base_url')
    this.baseUrl = base.replace(/\/$/, '')
    this.fetchImpl = opts.fetch ?? globalThis.fetch
  }

  withOrg(orgId: string): PayClient {
    return new PayClient({ ...this.opts, org_id: orgId, orgId })
  }

  private headers(json: boolean, extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = {}
    if (json) h['Content-Type'] = 'application/json'
    if (this.opts.token) h['Authorization'] = `Bearer ${this.opts.token}`
    const org = this.opts.org_id ?? this.opts.orgId // deprecated spelling, read until the last caller has moved
    if (org) h['X-Org-Id'] = org
    return { ...h, ...extra }
  }

  async api<T>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(body !== undefined, extra),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    if (res.status === 204) return null as T
    const text = await res.text()
    const data = text ? (JSON.parse(text) as unknown) : undefined
    if (!res.ok) {
      const e = (data ?? {}) as { error?: string | { code?: string; message?: string }; message?: string }
      const code = typeof e.error === 'string' ? e.error : e.error?.code ?? 'error'
      const msg = typeof e.error === 'object' ? e.error?.message : e.message
      throw new PayError(res.status, code, msg)
    }
    return data as T
  }

  get http(): HttpClient {
    return {
      api: this.api.bind(this),
      get: <T>(p: string, h?: Record<string, string>) => this.api<T>('GET', p, undefined, h),
      post: <T>(p: string, b: unknown, h?: Record<string, string>) => this.api<T>('POST', p, b, h),
      patch: <T>(p: string, b: unknown, h?: Record<string, string>) => this.api<T>('PATCH', p, b, h),
      del: <T>(p: string, h?: Record<string, string>) => this.api<T>('DELETE', p, undefined, h),
    }
  }

  /**
   * Charge a customer against a provider. Idempotent by `idempotency_key`.
   * The camelCase spelling of the input is still accepted and is sent as snake_case.
   */
  async charge(input: ChargeInput): Promise<Payment> {
    return withAliases((await this.api<{ payment: PaymentFields }>('POST', '/payments', chargeBody(input))).payment)
  }
  async list(opts: { status?: string; customer_id?: string; /** @deprecated Read `customer_id`. */ customerId?: string } = {}): Promise<Payment[]> {
    const q = new URLSearchParams()
    if (opts.status) q.set('status', opts.status)
    const customer = opts.customer_id ?? opts.customerId // deprecated spelling
    if (customer) q.set('customer', customer)
    const qs = q.toString()
    return (await this.api<{ payments: PaymentFields[] }>('GET', `/payments${qs ? `?${qs}` : ''}`)).payments.map(withAliases)
  }
  async get(ref: string): Promise<Payment> {
    return withAliases((await this.api<{ payment: PaymentFields }>('GET', `/payments/${encodeURIComponent(ref)}`)).payment)
  }
}

export function createPayClient(opts: PayClientOptions): PayClient {
  return new PayClient(opts)
}
