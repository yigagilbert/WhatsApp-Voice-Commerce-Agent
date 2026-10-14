import type { Customer, Database, DatabaseTx } from '@vca/database';
import { NotFoundError, ValidationError } from '@vca/shared';
import type { z } from 'zod';
import type { customerRefSchema } from '../commands';
import { closestMatches } from '../similarity';

export interface CreateCustomerInput {
  name: string;
  phone?: string | null;
  whatsappId?: string | null;
  email?: string | null;
  country?: string | null;
  preferredCurrency?: string | null;
}

export class CustomerService {
  constructor(private readonly db: Database) {}

  list(merchantId: string, limit = 100) {
    return this.db.customer.findMany({
      where: { merchantId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 500),
    });
  }

  async get(merchantId: string, id: string): Promise<Customer> {
    const customer = await this.db.customer.findFirst({ where: { merchantId, id } });
    if (!customer) throw new NotFoundError('Customer', id);
    return customer;
  }

  search(merchantId: string, query: string, limit = 5) {
    const q = query.trim();
    return this.db.customer.findMany({
      where: {
        merchantId,
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { email: { equals: q, mode: 'insensitive' } },
          { phone: q },
        ],
      },
      orderBy: { name: 'asc' },
      take: limit,
    });
  }

  create(merchantId: string, input: CreateCustomerInput, tx: DatabaseTx = this.db) {
    const name = input.name.trim();
    if (!name) throw new ValidationError('Customer name is required');
    return tx.customer.create({
      data: {
        merchantId,
        name,
        phone: input.phone ?? null,
        whatsappId: input.whatsappId ?? null,
        email: input.email ?? null,
        country: input.country ?? null,
        preferredCurrency: input.preferredCurrency ?? null,
      },
    });
  }

  /**
   * Resolves the customer referenced in an order command. Exact (case-insensitive) name
   * match wins; a single partial match is accepted; several matches require clarification;
   * no match creates a new customer (flagged so the summary can say so).
   */
  async resolveForOrder(
    merchantId: string,
    ref: z.infer<typeof customerRefSchema>,
    tx: DatabaseTx = this.db,
    options: { allowCreate?: boolean } = {},
  ): Promise<{ customer: Customer; isNew: boolean }> {
    if (ref.id) {
      const byId = await tx.customer.findFirst({ where: { merchantId, id: ref.id } });
      if (byId) return { customer: byId, isNew: false };
    }
    const exact = await tx.customer.findMany({
      where: { merchantId, name: { equals: ref.name.trim(), mode: 'insensitive' } },
      take: 2,
    });
    if (exact.length === 1 && exact[0]) return { customer: exact[0], isNew: false };

    const partial =
      exact.length > 1
        ? exact
        : await tx.customer.findMany({
            where: { merchantId, name: { contains: ref.name.trim(), mode: 'insensitive' } },
            take: 5,
          });
    if (partial.length === 1 && partial[0]) return { customer: partial[0], isNew: false };
    if (partial.length > 1) {
      throw new ValidationError(
        `Several customers match '${ref.name}': ${partial.map((c) => c.name).join(', ')}. Ask the merchant which one.`,
        { candidates: partial.map((c) => ({ id: c.id, name: c.name })) },
      );
    }
    if (options.allowCreate === false) {
      // Voice requests never create customers silently: a misheard name ("ssaala") must not
      // become a new customer. Suggest close matches and let the agent ask.
      const names = (
        await tx.customer.findMany({ where: { merchantId }, select: { name: true }, take: 500 })
      ).map((c) => c.name);
      const suggestions = closestMatches(ref.name, names);
      throw new ValidationError(
        `No customer named '${ref.name}'.${suggestions.length ? ` Did you mean ${suggestions.join(' or ')}?` : ''} Ask the merchant to confirm the customer (or to add them as a new customer).`,
        { suggestions },
      );
    }
    const customer = await this.create(
      merchantId,
      { name: ref.name, phone: ref.phone ?? null, email: ref.email ?? null },
      tx,
    );
    return { customer, isNew: true };
  }
}
