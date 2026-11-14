/**
 * The pay tools for an MCP server (`@baseworks/mcp`), over the same typed client the CLI uses:
 * a tool is a thin wrapper over pay-service's `/api`, so it can never do what the API would
 * refuse. `permission` is the name the service registered with org-service (`payment.read`,
 * `payment.charge`), used to hide a tool from somebody who may not use it.
 *
 *   import { payTools } from '@baseworks/pay/mcp'
 *   composeTools(payTools())
 *   // ctx.clients.pay is a PayClient built from the realm token
 *
 * Not offered, on purpose: the outcome fields of a charge (`status`, `provider_ref`,
 * `failure_reason`: only a realm service that ran the provider may say what happened) and the
 * `simulate_failure` test hook.
 */
import { z } from 'zod'
import { defineTool, type McpTool } from '@baseworks/mcp'
import type { PayClient } from './client.js'

/** What `ctx.clients` must hold for these tools. */
export interface PayMcpClients { pay: PayClient }

export function payTools(): McpTool<PayMcpClients>[] {
  return [
    defineTool({
      name: 'pay_list',
      title: 'List payments',
      description:
        'Lists the payments the organization has recorded (money collected from customers), newest first, with their amount, currency, status (`succeeded` or `failed`), provider and the customer they came from. ' +
        'Narrow with `status` or `customer_id` (a customer\'s id, short id or external id as the customer directory knows it). Amounts are integer cents: 5000 is 50.00. ' +
        'Returns `{ payments }`, up to 1000, without paging. Use pay_get when you know the one you want. Read only.',
      input: z.object({
        status: z.enum(['succeeded', 'failed']).optional().describe('Only payments with this outcome.'),
        customer_id: z.string().min(1).optional().describe('Only payments from this customer.'),
      }),
      access: 'read',
      permission: 'payment.read',
      run: async (ctx: { clients: PayMcpClients }, a: { status?: string; customer_id?: string }) => ({
        payments: await ctx.clients.pay.list({ ...(a.status ? { status: a.status } : {}), ...(a.customer_id ? { customer_id: a.customer_id } : {}) }),
      }),
    }),

    defineTool({
      name: 'pay_get',
      title: 'Get one payment',
      description:
        'Returns one payment in full: customer (id and the name as it was when charged), `amount_cents`, `currency`, `status`, `failure_reason` when it failed, `provider`, the provider\'s own `provider_ref`, the `invoice_id` it settles if any, and its `idempotency_key`. ' +
        '`ref` is the payment\'s id, its short id, or the idempotency key it was charged with. Fails with `not_found` if there is no such payment. Read only.',
      input: z.object({ ref: z.string().min(1).describe('The payment\'s id, short id or idempotency key.') }),
      access: 'read',
      permission: 'payment.read',
      run: async (ctx: { clients: PayMcpClients }, a: { ref: string }) => ({ payment: await ctx.clients.pay.get(a.ref) }),
    }),

    defineTool({
      name: 'pay_charge',
      title: 'Record a payment from a customer',
      description:
        'Records money collected from a customer and returns the payment. WRITES, and the record is permanent: there is no way to undo or edit a payment from here. ' +
        'With provider `manual` (the default) it writes down money that arrived some other way (a transfer, cash); it does not take money from anyone. `mock` is a pretend gateway for trying a flow out. ' +
        'Always ask the person for the amount, currency and which customer before calling it. `amount_cents` is an integer number of cents (50.00 is 5000). ' +
        '`idempotency_key` makes it safe to retry: charging again with the same key returns the payment that already exists and records nothing new, so choose a key that names this one collection (an invoice id and a sequence, say) and reuse it when you retry; never invent a fresh key for a retry. ' +
        '`customer_id` is a customer reference (id, short id or external id): an unknown one fails with `customer_not_found` and nothing is recorded. ' +
        'It is recorded as you, the agent acting for the person who connected you.',
      input: z.object({
        customer_id: z.string().min(1).describe('The customer: id, short id or external id from the customer directory.'),
        amount_cents: z.number().int().positive().describe('Amount in integer cents, greater than zero. 50.00 is 5000.'),
        currency: z.string().length(3).describe('ISO 4217 code, e.g. EUR, USD, TRY.'),
        idempotency_key: z.string().min(1).describe('Names this one collection; the same key never records twice.'),
        invoice_id: z.string().min(1).optional().describe('The invoice this settles, if any. It is not checked against the invoice service.'),
        provider: z.enum(['manual', 'mock']).optional().describe('`manual` (default): record money collected elsewhere. `mock`: a simulated gateway.'),
      }),
      access: 'write',
      permission: 'payment.charge',
      run: async (ctx: { clients: PayMcpClients }, a: { customer_id: string; amount_cents: number; currency: string; idempotency_key: string; invoice_id?: string; provider?: 'manual' | 'mock' }) =>
        ({ payment: await ctx.clients.pay.charge(a) }),
    }),
  ]
}
