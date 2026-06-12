import type { Command } from "commander";
import { loadServerEnv } from "../../config/env.js";
import { runSafelyAsync } from "../errors.js";
import { ui } from "../ui.js";

interface WorkerOptions {
  concurrency?: string;
}

export function registerWorkerCommand(program: Command): void {
  const worker = program
    .command("worker")
    .description("Run background workers for queued pull request reviews.");

  worker
    .command("start")
    .description("Start the review worker that processes webhook-enqueued jobs.")
    .option("--concurrency <n>", "number of jobs to process in parallel (default: 2)")
    .action((options: WorkerOptions) => {
      return runSafelyAsync(() => runWorker(options));
    });
}

async function runWorker(options: WorkerOptions): Promise<void> {
  loadServerEnv();

  const concurrency = options.concurrency ? Number.parseInt(options.concurrency, 10) : 2;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 50) {
    throw new Error(`Invalid concurrency: ${options.concurrency} (must be 1-50)`);
  }

  // Imported lazily so `hubolt worker --help` works without a database or
  // Redis available.
  const { createPrismaClient, disconnectPrismaClient } = await import("../../server/db.js");
  const { createRedisClient, connectRedis, disconnectRedis } = await import("../../server/redis.js");
  const { startReviewWorker } = await import("../../queue/worker.js");

  const db = createPrismaClient();
  const redis = createRedisClient();
  await connectRedis(redis);

  const handle = startReviewWorker({ db, redis, concurrency });
  console.log(ui.title("Hubolt review worker started"));
  console.log(`Queue: hubolt-review-jobs, concurrency: ${concurrency}`);
  console.log("Press Ctrl+C to stop.");

  await new Promise<void>((resolve) => {
    const shutdown = async (): Promise<void> => {
      console.log("Stopping review worker...");
      await handle.close();
      await disconnectRedis(redis);
      await disconnectPrismaClient(db);
      resolve();
    };

    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
  });
}
