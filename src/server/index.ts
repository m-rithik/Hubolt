import { createApp } from "./app.js";
import { createPrismaClient, disconnectPrismaClient } from "./db.js";
import { createRedisClient, connectRedis, disconnectRedis } from "./redis.js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "127.0.0.1";

async function start(): Promise<void> {
  const db = createPrismaClient();
  let redis: any = null;

  try {
    await db.$connect();
    console.log("Connected to database");

    redis = createRedisClient();
    try {
      await connectRedis(redis);
      console.log("Connected to Redis");
    } catch (error) {
      console.warn("Redis connection failed, LLM Gateway will be disabled:", error instanceof Error ? error.message : error);
      // Explicitly disconnect the failed Redis client to release resources
      try {
        await disconnectRedis(redis);
      } catch (e) {
        console.error("Failed to disconnect Redis after connection failure:", e);
      }
      redis = null;
    }

    const app = await createApp({ db, redis });

    const address = await app.listen({ port: PORT, host: HOST });
    console.log(`Server listening at ${address}`);

    const signals = ["SIGINT", "SIGTERM"];
    for (const signal of signals) {
      process.on(signal, async () => {
        console.log(`Received ${signal}, shutting down...`);
        await app.close();
        if (redis) {
          await disconnectRedis(redis);
        }
        await disconnectPrismaClient(db);
        process.exit(0);
      });
    }
  } catch (error) {
    console.error("Failed to start server:", error);
    if (redis) {
      try {
        await disconnectRedis(redis);
      } catch (e) {
        console.error("Failed to disconnect Redis:", e);
      }
    }
    await disconnectPrismaClient(db);
    process.exit(1);
  }
}

start();
