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

/**
 * Resolve connection options into the plain host/port shape BullMQ expects.
 * A url (REDIS_URL style) takes precedence and is decomposed into discrete
 * fields; BullMQ requires maxRetriesPerRequest to be null either way.
 */
export function toBullMqConnectionOptions(options: RedisConnectionOptions): RedisConnectionOptions {
  const { url, ...rest } = options;

  if (!url) {
    return { ...rest, maxRetriesPerRequest: null };
  }

  const parsed = new URL(url);
  const connection: RedisConnectionOptions = {
    ...rest,
    host: parsed.hostname,
    port: parsed.port ? Number.parseInt(parsed.port, 10) : 6379,
    maxRetriesPerRequest: null
  };

  const username = decodeRedisUrlPart(parsed.username);
  if (username) {
    connection.username = username;
  }

  const password = decodeRedisUrlPart(parsed.password);
  if (password) {
    connection.password = password;
  }

  const db = parseRedisDatabase(parsed.pathname);
  if (db !== undefined) {
    connection.db = db;
  }

  if (parsed.protocol === "rediss:") {
    connection.tls = {};
  }

  return connection;
}

function decodeRedisUrlPart(value: string): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseRedisDatabase(pathname: string): number | undefined {
  if (!pathname || pathname === "/") {
    return undefined;
  }

  const db = Number.parseInt(pathname.slice(1), 10);
  return Number.isInteger(db) && db >= 0 ? db : undefined;
}

export async function connectRedis(client: RedisClient): Promise<void> {
  await client.connect();
}

export async function disconnectRedis(client: RedisClient): Promise<void> {
  await client.quit();
}
