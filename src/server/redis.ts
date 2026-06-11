import { Redis, type RedisOptions } from "ioredis";

const connectionOptionsKey = Symbol("redisConnectionOptions");

export type RedisConnectionOptions = RedisOptions & {
  url?: string;
  maxRetriesPerRequest: null;
};

export type RedisClient = Redis & {
  [connectionOptionsKey]?: RedisConnectionOptions;
};

export function createRedisConnectionOptions(): RedisConnectionOptions {
  return {
    url: process.env.REDIS_URL || "redis://localhost:6379",
    lazyConnect: true,
    maxRetriesPerRequest: null
  };
}

export function createRedisClient(): RedisClient {
  const connectionOptions = createRedisConnectionOptions();
  const { url, ...redisOptions } = connectionOptions;

  const client = new Redis(url ?? "redis://localhost:6379", redisOptions) as RedisClient;
  client[connectionOptionsKey] = connectionOptions;

  client.on("error", (err: unknown) => {
    console.error("Redis error:", err);
  });

  return client;
}

export function getRedisConnectionOptions(client: RedisClient): RedisConnectionOptions {
  const connectionOptions = client[connectionOptionsKey];
  if (connectionOptions) {
    return { ...connectionOptions };
  }

  return {
    ...client.options,
    maxRetriesPerRequest: null
  };
}

export async function connectRedis(client: RedisClient): Promise<void> {
  await client.connect();
}

export async function disconnectRedis(client: RedisClient): Promise<void> {
  await client.quit();
}
