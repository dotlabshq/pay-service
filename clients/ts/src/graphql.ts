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
      ctx.pay.list({ customerId: parent.id, ...(status ? { status } : {}) }),
  },
  Payment: {
    customer: (parent: Payment, _: unknown, ctx: PayGraphContext) => ctx.customerLoader.load(parent.customerId),
  },
}
