import { Command } from 'commander'
import { kv, table, summary, success, fatal, printOutput, outputOption } from '@baseworks/cli/display'
import type { ColDef } from '@baseworks/cli/display'
import type { ApiClient } from '@baseworks/cli/client'

/**
 * The `payments` command group for pay-service:
 *
 *   program.addCommand(buildPayCommand({ http, cliName: 'dtab' }))
 *   → dtab payments charge | ls | get
 *
 * `http` carries the identity token and must send the active org (X-Org-Id).
 */
export interface PayCliDeps {
  http: ApiClient
  cliName?: string
}

const die = (e: unknown): never => fatal(e instanceof Error ? e.message : String(e))

function fmtMoney(cents: number, currency: string): string {
  return `${(cents / 100).toFixed(2)} ${currency}`
}
function toCents(amount: string, flag: string): number {
  const n = Number(amount)
  if (!Number.isFinite(n) || n < 0) fatal(`${flag} must be a non-negative number, got '${amount}'`)
  const cents = Math.round(n * 100)
  if (Math.abs(cents - n * 100) > 1e-6) fatal(`${flag} has sub-cent precision: '${amount}'`)
  return cents
}

type PayRow = {
  id: string; shortId: string; customerName: string | null; customerId: string
  amountCents: number; currency: string; provider: string; status: string
  invoiceId: string | null; providerRef: string; failureReason: string | null; idempotencyKey: string
}

export function buildPayCommand(deps: PayCliDeps): Command {
  const { http } = deps
  const cli = deps.cliName ?? 'cli'
  const list = async (opts: { output: string; status?: string; customer?: string }) => {
    const q = new URLSearchParams()
    if (opts.status) q.set('status', opts.status)
    if (opts.customer) q.set('customer', opts.customer)
    const qs = q.toString()
    const res = await http.get<{ payments: PayRow[] }>(`/payments${qs ? `?${qs}` : ''}`).catch(die)
    printOutput(res.payments, opts.output, (wide) => {
      table(res.payments, [
        { key: 'shortId', label: 'ID' },
        { key: 'customerName', label: 'CUSTOMER', fmt: (v, r) => (v as string) ?? (r as PayRow).customerId },
        { key: 'amountCents', label: 'AMOUNT', fmt: (v, r) => fmtMoney(v as number, (r as PayRow).currency) },
        { key: 'provider', label: 'PROVIDER' },
        { key: 'status', label: 'STATUS' },
        { key: 'invoiceId', label: 'INVOICE', fmt: (v) => (v as string) ?? '—' },
        { key: 'id', label: 'FULL ID', wide: true },
      ] as ColDef<PayRow>[], { wide, emptyHint: `No payments yet.  Run: ${cli} payments charge --customer <ref> --amount 50.00 --key <id>` })
      summary(`${res.payments.length} payment${res.payments.length !== 1 ? 's' : ''}`)
    }, 'id')
  }

  // NB: the bare `payments` command only declares `--status` (not `--customer`) so
  // its option names don't collide with the `charge` subcommand's `--customer`
  // under positional-options parsing. Filter by customer via `payments ls --customer`.
  const cmd = new Command('payments').alias('pay').description('Payment collection — charge a customer against a provider')
    .option(...outputOption()).option('--status <status>', 'succeeded | failed')
    .action(list)
  cmd.addCommand(new Command('ls').option(...outputOption()).option('--status <status>').option('--customer <ref>').description('List payments')
    .action(function (this: Command) { const s = this.opts() as { output?: string; status?: string; customer?: string }; const p = (this.parent?.opts() ?? {}) as { output?: string; status?: string; customer?: string }; return list({ output: s.output && s.output !== 'table' ? s.output : p.output ?? 'table', status: s.status ?? p.status, customer: s.customer ?? p.customer }) }))
  cmd.addCommand(new Command('charge').description('Charge a customer (idempotent by --key)')
    .requiredOption('--customer <ref>', 'Customer id / short_id / external_id')
    .requiredOption('--amount <amount>', 'Amount, e.g. 50.00')
    .requiredOption('--key <id>', 'Idempotency key — unique per org')
    .option('--currency <cur>', 'ISO-4217 currency', 'USD')
    .option('--provider <name>', 'manual | mock', 'manual')
    .option('--invoice <ref>', 'Invoice this payment settles')
    .option('--fail', 'Simulate a provider decline (test)')
    .action(async (o: { customer: string; amount: string; key: string; currency: string; provider: string; invoice?: string; fail?: boolean }) => {
      const body = {
        customerId: o.customer, amountCents: toCents(o.amount, '--amount'), currency: o.currency,
        provider: o.provider, idempotencyKey: o.key,
        ...(o.invoice ? { invoiceId: o.invoice } : {}),
        ...(o.fail ? { simulateFailure: true } : {}),
      }
      const res = await http.post<{ payment: PayRow }>('/payments', body).catch(die)
      const p = res.payment
      if (p.status === 'succeeded') success(`Charged ${fmtMoney(p.amountCents, p.currency)} — ${p.status}`)
      else console.log(`  ✗ Payment ${p.status}: ${p.failureReason ?? ''}`)
      kv([['id', p.shortId], ['status', p.status], ['provider', p.provider], ['amount', fmtMoney(p.amountCents, p.currency)], ['provider_ref', p.providerRef]])
    }))
  cmd.addCommand(new Command('get').argument('<ref>').description('Show a payment').option(...outputOption())
    .action(async (ref: string, o: { output: string }) => {
      const res = await http.get<{ payment: PayRow }>(`/payments/${ref}`).catch(die)
      const p = res.payment
      printOutput(p as unknown as Record<string, unknown>, o.output, () => kv([
        ['id', p.shortId], ['customer', p.customerName ?? p.customerId], ['amount', fmtMoney(p.amountCents, p.currency)],
        ['provider', p.provider], ['status', p.status], ['invoice', p.invoiceId ?? '—'],
        ['provider_ref', p.providerRef], ['key', p.idempotencyKey], ['full_id', p.id],
      ]), 'id')
    }))
  return cmd
}
