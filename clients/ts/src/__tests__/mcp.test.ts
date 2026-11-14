/** The pay tools: names, access, permissions, inputs, what they call, what a model is told. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { composeTools, runStdio } from '@baseworks/mcp'
import { PayError } from '../client.js'
import { payTools } from '../mcp.js'

const calls: Array<[string, ...unknown[]]> = []
const fake = {
  list: async (o: unknown) => { calls.push(['list', o]); return [{ id: 'p1', amount_cents: 500 }] },
  get: async (ref: string) => { calls.push(['get', ref]); if (ref === 'gone') throw new PayError(404, 'not_found', 'Payment not found'); return { id: 'p2', short_id: ref } },
  charge: async (a: unknown) => { calls.push(['charge', a]); return { id: 'p3', ...(a as object) } },
}

async function session(over: Partial<Parameters<typeof runStdio>[0]> = {}) {
  const [a, b] = InMemoryTransport.createLinkedPair()
  await runStdio({ tools: composeTools(payTools()), token: 'x.y.z', transport: a, clients: () => ({ pay: fake }), ...over } as never)
  const client = new Client({ name: 'c', version: '1' })
  await client.connect(b)
  calls.length = 0
  return client
}
const out = (r: { content?: unknown }) => JSON.parse(((r.content as Array<{ text: string }>)[0]!).text)

describe('the tool set', () => {
  it('is <service>_<verb>, composes with itself once, and says read or write with the permission the service registered', () => {
    const tools = payTools()
    expect(tools.map((t) => [t.name, t.access, t.permission])).toEqual([
      ['pay_list', 'read', 'payment.read'], ['pay_get', 'read', 'payment.read'], ['pay_charge', 'write', 'payment.charge'],
    ])
    expect(composeTools(tools)).toHaveLength(3)
    expect(() => composeTools(tools, payTools())).toThrow(/duplicate/)
  })

  it('permission names are the ones pay-service registers', async () => {
    const { PAY_ACTIONS } = await import('../../../../src/lib/org.js')
    for (const t of payTools()) expect(Object.keys(PAY_ACTIONS)).toContain(t.permission)
  })

  it('descriptions are written for a model: units, idempotency, what is permanent', () => {
    const d = Object.fromEntries(payTools().map((t) => [t.name, t.description]))
    expect(d['pay_list']).toMatch(/integer cents/)
    expect(d['pay_get']).toMatch(/idempotency key/)
    expect(d['pay_charge']).toMatch(/WRITES/)
    expect(d['pay_charge']).toMatch(/permanent/)
    expect(d['pay_charge']).toMatch(/does not take money/)
    expect(d['pay_charge']).toMatch(/same key/)
    expect(d['pay_charge']).toMatch(/customer_not_found/)
    for (const t of payTools()) expect(t.description.length, t.name).toBeGreaterThan(120)
  })

  it('does not offer what only a service may say: the outcome fields and the failure hook', () => {
    const shape = JSON.stringify(Object.keys(payTools()[2]!.input.shape))
    expect(shape).not.toMatch(/status|provider_ref|failure_reason|simulate/)
  })
})

describe('through a real MCP client', () => {
  it('lists the three tools, with read-only hints and the required inputs', async () => {
    const t = (await (await session()).listTools()).tools
    expect(t.map((x) => x.name)).toEqual(['pay_list', 'pay_get', 'pay_charge'])
    expect(t.find((x) => x.name === 'pay_charge')!.annotations).toMatchObject({ readOnlyHint: false })
    expect(t.find((x) => x.name === 'pay_list')!.annotations).toMatchObject({ readOnlyHint: true })
    expect((t.find((x) => x.name === 'pay_charge')!.inputSchema as { required?: string[] }).required!.sort()).toEqual(['amount_cents', 'currency', 'customer_id', 'idempotency_key'])
  })

  it('list: filters pass through, and an empty call lists everything', async () => {
    const c = await session()
    expect(out(await c.callTool({ name: 'pay_list', arguments: { status: 'failed', customer_id: 'c-1' } }))).toEqual({ payments: [{ id: 'p1', amount_cents: 500 }] })
    expect(calls).toEqual([['list', { status: 'failed', customer_id: 'c-1' }]])
    calls.length = 0
    await c.callTool({ name: 'pay_list', arguments: {} })
    expect(calls).toEqual([['list', {}]])
  })

  it('get: by ref; a missing payment is an error the model can read', async () => {
    const c = await session()
    expect(out(await c.callTool({ name: 'pay_get', arguments: { ref: 'py1' } }))).toEqual({ payment: { id: 'p2', short_id: 'py1' } })
    const r = await c.callTool({ name: 'pay_get', arguments: { ref: 'gone' } })
    expect((r as { isError?: boolean }).isError).toBe(true)
    expect(JSON.stringify(r.content)).toMatch(/not_found/)
  })

  it('charge: sends exactly what was given; refuses a zero or fractional amount, a short currency, an unknown provider; ignores what it does not offer', async () => {
    const c = await session()
    const ok = { customer_id: 'c-1', amount_cents: 5000, currency: 'EUR', idempotency_key: 'inv-7-1', invoice_id: 'inv-7', provider: 'mock' }
    expect(out(await c.callTool({ name: 'pay_charge', arguments: ok })).payment).toMatchObject(ok)
    expect(calls).toEqual([['charge', ok]])
    calls.length = 0
    for (const bad of [{ ...ok, amount_cents: 0 }, { ...ok, amount_cents: 1.5 }, { ...ok, currency: 'EU' }, { ...ok, provider: 'stripe' }, { ...ok, idempotency_key: '' }]) {
      const r = await c.callTool({ name: 'pay_charge', arguments: bad }).catch((e) => e)
      expect(r instanceof Error || (r as { isError?: boolean }).isError, JSON.stringify(bad)).toBeTruthy()
    }
    // fields only a service may set never reach the client
    await c.callTool({ name: 'pay_charge', arguments: { ...ok, status: 'succeeded', provider_ref: 'pi_1', simulate_failure: true } }).catch(() => undefined)
    for (const [, arg] of calls) expect(Object.keys(arg as object)).not.toEqual(expect.arrayContaining(['status']))
  })

  it('a token that may only read is not shown the write tool', async () => {
    const [a, b] = InMemoryTransport.createLinkedPair()
    await runStdio({ tools: composeTools(payTools()), token: 'x.y.z', transport: a, clients: () => ({ pay: fake }), permissions: async () => ['payment.read'] } as never)
    const client = new Client({ name: 'c', version: '1' })
    await client.connect(b)
    const names = (await client.listTools()).tools.map((x) => x.name)
    expect(names).toContain('pay_list')
    expect(names).not.toContain('pay_charge')
  })
})
