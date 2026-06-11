import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { PrismaClient } from "../generated/prisma/index.js";

const prismaPoolKey: unique symbol = Symbol("hubolt.prismaPgPool");

type PrismaClientWithPool = PrismaClient & {
  [prismaPoolKey]?: Pool;
};

export function createPrismaClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to start the Hubolt server.");
  }

  const pool = new Pool({ connectionString });
  const adapter = new PrismaPg(pool);
  const db = new PrismaClient({ adapter }) as PrismaClientWithPool;
  db[prismaPoolKey] = pool;

  return db;
}

export async function disconnectPrismaClient(db: PrismaClient): Promise<void> {
  const pooledClient = db as PrismaClientWithPool;
  const pool = pooledClient[prismaPoolKey];

  try {
    await db.$disconnect();
  } finally {
    if (pool) {
      delete pooledClient[prismaPoolKey];
      await pool.end();
    }
  }
}
