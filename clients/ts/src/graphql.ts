import type { createPayClient, Payment } from './client.js'

/** GraphQL read module for payments — Payment type, `extend`s Customer. */
export interface PayGraphContext {
  pay: ReturnType<typeof createPayClient>
  customerLoader: { load(id: string): Promise<unknown> }
}

export const typeDefs = /* GraphQL */ `
  type Payment {
    id: ID!
    shortId: String!
    amountCents: Int!
    currency: String!
    status: String!
    provider: String!
    providerRef: String!
    invoiceId: String
    createdAt: Float!
    customer: Customer
  }
  extend type Query {
    payment(ref: String!): Payment
  }
  extend type Customer {
    payments(status: String): [Payment!]!
  }
`

export const resolvers = {
  Query: {
    payment: (_: unknown, { ref }: { ref: string }, ctx: PayGraphContext) => ctx.pay.get(ref).catch(() => null),
  },
  Customer: {
    // pay-service supports a customer filter server-side (efficient).
    payments: (parent: { id: string }, { status }: { status?: string }, ctx: PayGraphContext) =>
      ctx.pay.list({ customer_id: parent.id, ...(status ? { status } : {}) }),
  },
  // GraphQL names its fields in camelCase; the service's wire is snake_case.
  Payment: {
    shortId: (p: Payment) => p.short_id,
    amountCents: (p: Payment) => p.amount_cents,
    providerRef: (p: Payment) => p.provider_ref,
    invoiceId: (p: Payment) => p.invoice_id,
    createdAt: (p: Payment) => p.created_at,
    customer: (parent: Payment, _: unknown, ctx: PayGraphContext) => ctx.customerLoader.load(parent.customer_id),
  },
}
