import type { Payment, ChargeInput } from './types.js'

export type {
  Payment, Provider, PaymentStatus, PaymentRow, ChargeInput,
} from './types.js'

export interface PayClientOptions {
  /** Base URL of pay-service (e.g. PAY_SERVICE_URL). */
  baseUrl: string
  /** Bearer token — the caller's identity JWT. */
  token?: string
  /** Active org id — sent as X-Org-Id (pay is org-scoped, tenant = org). */
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
export class PayClient {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  constructor(private readonly opts: PayClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '')
    this.fetchImpl = opts.fetch ?? globalThis.fetch
  }

  withOrg(orgId: string): PayClient {
    return new PayClient({ ...this.opts, orgId })
  }

  private headers(json: boolean, extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = {}
    if (json) h['Content-Type'] = 'application/json'
    if (this.opts.token) h['Authorization'] = `Bearer ${this.opts.token}`
    if (this.opts.orgId) h['X-Org-Id'] = this.opts.orgId
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

  /** Charge a customer against a provider. Idempotent by `idempotencyKey`. */
  async charge(input: ChargeInput): Promise<Payment> {
    return (await this.api<{ payment: Payment }>('POST', '/v1/payments', input)).payment
  }
  async list(opts: { status?: string; customerId?: string } = {}): Promise<Payment[]> {
    const q = new URLSearchParams()
    if (opts.status) q.set('status', opts.status)
    if (opts.customerId) q.set('customer', opts.customerId)
    const qs = q.toString()
    return (await this.api<{ payments: Payment[] }>('GET', `/v1/payments${qs ? `?${qs}` : ''}`)).payments
  }
  async get(ref: string): Promise<Payment> {
    return (await this.api<{ payment: Payment }>('GET', `/v1/payments/${ref}`)).payment
  }
}

export function createPayClient(opts: PayClientOptions): PayClient {
  return new PayClient(opts)
}
