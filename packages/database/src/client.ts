import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client';

export interface CreatePrismaClientOptions {
  databaseUrl: string;
  log?: boolean;
}

/** Creates a Prisma client backed by the node-postgres driver adapter. */
export function createPrismaClient({ databaseUrl, log = false }: CreatePrismaClientOptions) {
  const adapter = new PrismaPg({ connectionString: databaseUrl });
  return new PrismaClient({ adapter, log: log ? ['query', 'warn', 'error'] : ['warn', 'error'] });
}

export type Database = ReturnType<typeof createPrismaClient>;

/** Transaction client type, for services that accept either the root client or a transaction. */
export type DatabaseTx = Omit<
  Database,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'
>;
