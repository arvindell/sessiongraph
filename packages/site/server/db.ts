import { PrismaPg } from '@prisma/adapter-pg';
import { AuroraDSQLPool } from '@aws/aurora-dsql-node-postgres-connector';
import { awsCredentialsProvider } from '@vercel/oidc-aws-credentials-provider';
import { PrismaClient, Prisma } from '../generated/prisma/client';

let client: PrismaClient | undefined;
export function database() {
  if (client) return client;
  if (!process.env.DSQL_ENDPOINT) throw new Error('Database is not configured.');
  const pool = new AuroraDSQLPool({
    host: process.env.DSQL_ENDPOINT, user: process.env.DSQL_USER || 'sessiongraph', database: 'postgres',
    region: process.env.DSQL_REGION || 'us-west-2', options: '-c search_path=sessiongraph', max: 3, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 10_000,
    ssl: { rejectUnauthorized: true },
    ...(process.env.AWS_ROLE_ARN ? { customCredentialsProvider: awsCredentialsProvider({ roleArn: process.env.AWS_ROLE_ARN }) } : {}),
  });
  client = new PrismaClient({ adapter: new PrismaPg(pool, { schema: 'sessiongraph' }) });
  return client;
}
export type DB = ReturnType<typeof database>;
export type Transaction = Prisma.TransactionClient;

/** Retry the entire transaction on DSQL optimistic conflicts, never individual statements. */
export async function transaction<T>(db: DB, work: (tx: Transaction) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await db.$transaction(work); }
    catch (error) {
      const text = error instanceof Error ? error.message : '';
      if (attempt >= 3 || !(/OC000|OC001|40001|write conflict|deadlock/i.test(text) || (error as { code?: string }).code === 'P2034')) throw error;
      await new Promise(resolve => setTimeout(resolve, 20 * 2 ** attempt + Math.random() * 30));
    }
  }
}
