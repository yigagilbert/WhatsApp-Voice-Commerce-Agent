import type { FastifyInstance } from 'fastify';
import { normalizeCurrency, toMinorUnits } from '@vca/commerce';
import { z } from 'zod';
import type { Container } from '../../container';
import { parse } from '../../http/validation';

const createCustomerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().email().optional(),
  phone: z.string().max(32).optional(),
  whatsappId: z.string().max(64).optional(),
  country: z.string().length(2).optional(),
  preferredCurrency: z.string().length(3).optional(),
});

const createProductSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(1000).optional(),
  sku: z.string().max(64).optional(),
  /** Major units, e.g. 12.5 */
  unitPrice: z.union([z.number().nonnegative(), z.string()]),
  currency: z.string().length(3).optional(),
  stockQuantity: z.number().int().nonnegative().optional(),
});

const idParams = z.object({ id: z.string().min(1).max(64) });

/** Customers and products (dashboard). */
export async function catalogRoutes(app: FastifyInstance, { container }: { container: Container }) {
  app.get('/api/customers', async (request) => container.customers.list(request.merchant.id));

  /** Customers with order count, paid revenue and last order date (Customers grid). */
  app.get('/api/customers/stats', async (request) =>
    container.analytics.customerStats(request.merchant.id),
  );

  app.get('/api/customers/:id', async (request) =>
    container.customers.get(request.merchant.id, parse(idParams, request.params).id),
  );

  app.post('/api/customers', async (request, reply) => {
    const body = parse(createCustomerSchema, request.body);
    const customer = await container.customers.create(request.merchant.id, body);
    return reply.status(201).send(customer);
  });

  app.get('/api/products', async (request) => container.products.list(request.merchant.id));

  /** Products with units sold and revenue from paid orders (Products grid). */
  app.get('/api/products/stats', async (request) =>
    container.analytics.productStats(request.merchant.id),
  );

  app.post('/api/products', async (request, reply) => {
    const body = parse(createProductSchema, request.body);
    const currency = normalizeCurrency(body.currency ?? request.merchant.preferredCurrency);
    const product = await container.products.create(request.merchant.id, {
      name: body.name,
      description: body.description ?? null,
      sku: body.sku ?? null,
      currency,
      unitPriceMinor: toMinorUnits(body.unitPrice, currency),
      stockQuantity: body.stockQuantity ?? null,
    });
    return reply.status(201).send(product);
  });
}
