import { beforeEach, describe, expect, test, vi } from "vitest";

const dbMocks = vi.hoisted(() => {
  const pools: any[] = [];
  const clients: any[] = [];

  class MockPool {
    options: any;
    end = vi.fn().mockResolvedValue(undefined);

    constructor(options: any) {
      this.options = options;
      pools.push(this);
    }
  }

  class MockPrismaPg {
    pool: any;

    constructor(pool: any) {
      this.pool = pool;
    }
  }

  class MockPrismaClient {
    args: any;
    $disconnect = vi.fn().mockResolvedValue(undefined);

    constructor(args: any) {
      this.args = args;
      clients.push(this);
    }
  }

  return {
    pools,
    clients,
    MockPool,
    MockPrismaPg,
    MockPrismaClient
  };
});

vi.mock("pg", () => ({
  Pool: dbMocks.MockPool
}));

vi.mock("@prisma/adapter-pg", () => ({
  PrismaPg: dbMocks.MockPrismaPg
}));

vi.mock("../../src/generated/prisma/index.js", () => ({
  PrismaClient: dbMocks.MockPrismaClient
}));

import { createPrismaClient, disconnectPrismaClient } from "../../src/server/db.js";

describe("database client", () => {
  beforeEach(() => {
    dbMocks.pools.length = 0;
    dbMocks.clients.length = 0;
    process.env.DATABASE_URL = "postgresql://hubolt:hubolt@localhost:5432/hubolt";
    vi.clearAllMocks();
  });

  test("ends the pg pool when disconnecting the Prisma client", async () => {
    const db = createPrismaClient();

    await disconnectPrismaClient(db);

    expect(dbMocks.clients[0].$disconnect).toHaveBeenCalledOnce();
    expect(dbMocks.pools[0].end).toHaveBeenCalledOnce();
  });
});
