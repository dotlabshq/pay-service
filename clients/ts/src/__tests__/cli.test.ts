/// <reference types="vitest/globals" />
import { beforeAll, afterEach, afterAll, describe, it, expect } from 'vitest'
import { Command } from 'commander'
import { buildPayCommand } from '../cli.js'
import { createApiClient } from '@baseworks/cli/client'
import { runCommand, createMocks, server } from '@baseworks/cli/testing'

const TEST_BASE = 'http://pay.test'
const mocks = createMocks(TEST_BASE)
function run(args: string[]) {
  const http = createApiClient(() => 'tok', () => TEST_BASE)
  const program = new Command('dtab').exitOverride().enablePositionalOptions()
  program.addCommand(buildPayCommand({ http, cliName: 'dtab' }))
  return runCommand(program, args)
}

beforeAll(() => server.listen({ onUnhandledRequest: 'warn' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const PAID = { id: 'pay-1', short_id: 'py1', customer_name: 'Acme', customer_id: 'c-1', amount_cents: 5000, currency: 'USD', provider: 'manual', provider_ref: 'manual:py1', status: 'succeeded', invoice_id: null, failure_reason: null, idempotency_key: 'k-1' }

describe('dtab payments', () => {
  it('lists with amount + status', async () => {
    mocks.mockGet('/payments', { payments: [PAID] })
    const r = await run(['payments'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('py1'); expect(r.stdout).toContain('50.00 USD'); expect(r.stdout).toContain('succeeded')
  })
  it('charge parses --amount → cents and sends the idempotency key', async () => {
    const cap = mocks.mockPostCapture('/payments', { payment: PAID })
    const r = await run(['payments', 'charge', '--customer', 'c-1', '--amount', '50.00', '--key', 'k-1'])
    expect(r.exitCode).toBe(0)
    const b = cap.body as Record<string, unknown>
    expect(b.amount_cents).toBe(5000); expect(b.idempotency_key).toBe('k-1'); expect(b.provider).toBe('manual')
    expect(r.stdout).toContain('succeeded')
  })
  it('charge --fail sends simulate_failure and shows the decline', async () => {
    const cap = mocks.mockPostCapture('/payments', { payment: { ...PAID, status: 'failed', failure_reason: 'card_declined' } })
    const r = await run(['payments', 'charge', '--customer', 'c-1', '--amount', '50.00', '--key', 'k-2', '--fail'])
    expect(r.exitCode).toBe(0)
    expect((cap.body as Record<string, unknown>).simulate_failure).toBe(true)
    expect(r.stdout).toContain('failed'); expect(r.stdout).toContain('card_declined')
  })
  it('rejects a sub-cent --amount', async () => {
    const r = await run(['payments', 'charge', '--customer', 'c-1', '--amount', '1.999', '--key', 'k-3'])
    expect(r.exitCode).not.toBe(0); expect(r.stderr).toContain('sub-cent')
  })
})
