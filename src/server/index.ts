import { createApp } from "./app.js";
import { createPrismaClient } from "./db.js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "127.0.0.1";

async function start(): Promise<void> {
  const db = createPrismaClient();

  try {
    await db.$connect();
    console.log("Connected to database");

    const app = await createApp({ db });

    const address = await app.listen({ port: PORT, host: HOST });
    console.log(`Server listening at ${address}`);

    const signals = ["SIGINT", "SIGTERM"];
    for (const signal of signals) {
      process.on(signal, async () => {
        console.log(`Received ${signal}, shutting down...`);
        await app.close();
        await db.$disconnect();
        process.exit(0);
      });
    }
  } catch (error) {
    console.error("Failed to start server:", error);
    await db.$disconnect();
    process.exit(1);
  }
}

start();
