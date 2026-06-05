import { resolve } from "node:path";
import { cancel, confirm, intro, isCancel, text } from "@clack/prompts";
import type { Command } from "commander";
import { writeEnvFile } from "../../config/env-file.js";
import { generateApiKey, hashApiKey } from "../../server/api-keys.js";
import { runSafelyAsync } from "../errors.js";

interface ServerOptions {
  port?: string;
  host?: string;
}

interface BootstrapOptions {
  org?: string;
  email?: string;
  name?: string;
  keyName?: string;
  saveEnv?: boolean;
  envFile?: string;
  serverUrl?: string;
}

export function registerServerCommand(program: Command): void {
  const server = program
    .command("server")
    .description("Start and manage the Hubolt middleware server.");

  server
    .option("--port <port>", "port to listen on (default: 3000)")
    .option("--host <host>", "host to listen on (default: 127.0.0.1)")
    .action((options: ServerOptions) => {
      return runSafelyAsync(() => runServer(options));
    });

  server
    .command("bootstrap")
    .description("Create the first local organization, admin user, and API key.")
    .option("--org <slug>", "organization slug, for example rithik")
    .option("--email <email>", "admin user email")
    .option("--name <name>", "organization display name")
    .option("--key-name <name>", "API key name (default: local-dev)")
    .option("--env-file <path>", "env file to update (default: .env)")
    .option("--server-url <url>", "server URL to save with HUBOLT_SERVER_URL (default: http://127.0.0.1:3000)")
    .option("--save-env", "save HUBOLT_SERVER_URL and HUBOLT_API_KEY to an env file without prompting")
    .option("--no-save-env", "do not save HUBOLT_SERVER_URL and HUBOLT_API_KEY to an env file")
    .action((options: BootstrapOptions) => {
      return runSafelyAsync(() => bootstrapServer(options));
    });
}

async function runServer(options: ServerOptions): Promise<void> {
  const portStr = options.port || process.env.PORT || "3000";
  const port = parseInt(portStr, 10);

  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${portStr} (must be 1-65535)`);
  }

  process.env.HOST = options.host || process.env.HOST || "127.0.0.1";

  const { createApp } = await import("../../server/app.js");
  const { createPrismaClient } = await import("../../server/db.js");

  const db = createPrismaClient();

  try {
    await db.$connect();
    console.log("Connected to database");

    const app = await createApp({ db });
    const address = await app.listen({ port, host: process.env.HOST });
    console.log(`Server listening at ${address}`);
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

async function bootstrapServer(options: BootstrapOptions): Promise<void> {
  const resolved = await resolveBootstrapOptions(options);
  const slug = normalizeOrgSlug(resolved.org);
  const email = normalizeEmail(resolved.email);
  const orgName = resolved.name?.trim() || slug;
  const keyName = resolved.keyName;
  const key = generateApiKey();
  const serverUrl = normalizeServerUrl(resolved.serverUrl);

  const { createPrismaClient } = await import("../../server/db.js");
  const db = createPrismaClient();

  try {
    await db.$connect();

    const org = await db.organization.upsert({
      where: { slug },
      create: {
        slug,
        name: orgName
      },
      update: {
        name: orgName
      }
    });

    const user = await db.user.upsert({
      where: { email },
      create: {
        email,
        name: email.split("@")[0]
      },
      update: {}
    });

    await db.organizationMember.upsert({
      where: {
        orgId_userId: {
          orgId: org.id,
          userId: user.id
        }
      },
      create: {
        orgId: org.id,
        userId: user.id,
        role: "admin"
      },
      update: {
        role: "admin"
      }
    });

    const apiKey = await db.apiKey.create({
      data: {
        orgId: org.id,
        name: keyName,
        keyHash: hashApiKey(key)
      }
    });

    await db.auditEvent.create({
      data: {
        orgId: org.id,
        action: "server.bootstrap",
        resource: "api_key",
        resourceId: apiKey.id,
        details: JSON.stringify({ email, keyName })
      }
    });

    console.log("Hubolt server bootstrap complete");
    console.log(`Organization: ${org.slug}`);
    console.log(`Admin user:   ${user.email}`);

    if (resolved.saveEnv) {
      const envPath = resolve(process.cwd(), resolved.envFile);
      writeEnvFile(envPath, {
        HUBOLT_SERVER_URL: serverUrl,
        HUBOLT_API_KEY: key
      });
      console.log(`API key:      saved to ${envPath}`);
      console.log(`Key prefix:   ${key.slice(0, 14)}...`);
    } else {
      console.log(`API key:      ${key}`);
    }
  } finally {
    await db.$disconnect();
  }
}

interface ResolvedBootstrapOptions {
  org: string;
  email: string;
  name?: string;
  keyName: string;
  saveEnv: boolean;
  envFile: string;
  serverUrl: string;
}

async function resolveBootstrapOptions(options: BootstrapOptions): Promise<ResolvedBootstrapOptions> {
  const canPrompt = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const shouldPromptForCore = !options.org || !options.email;
  const shouldPromptForSave = options.saveEnv === undefined && canPrompt;
  const shouldPrompt = shouldPromptForCore || shouldPromptForSave;

  if (shouldPromptForCore && !canPrompt) {
    throw new Error("Missing bootstrap values. Pass --org and --email in non-interactive mode.");
  }

  if (options.saveEnv === undefined && !canPrompt) {
    throw new Error("Pass --save-env or --no-save-env in non-interactive mode.");
  }

  if (shouldPrompt) {
    intro("Hubolt server bootstrap");
  }

  const org = options.org ?? (await promptRequiredText("Organization slug", "rithik"));
  const email = options.email ?? (await promptRequiredText("Admin email", "you@example.com"));
  const name = options.name ?? (shouldPromptForCore ? await promptOptionalText("Organization display name", org) : undefined);
  const keyName = options.keyName?.trim() || (shouldPromptForCore ? await promptRequiredText("API key name", "local-dev") : "local-dev");

  let saveEnv = Boolean(options.saveEnv);
  if (shouldPromptForSave) {
    saveEnv = await promptConfirm("Save server URL and API key to .env?", true);
  }

  const envFile = saveEnv
    ? options.envFile?.trim() || (shouldPrompt ? await promptRequiredText("Env file", ".env") : ".env")
    : options.envFile?.trim() || ".env";

  const serverUrl = saveEnv
    ? options.serverUrl?.trim() || (shouldPrompt ? await promptRequiredText("Server URL", "http://127.0.0.1:3000") : "http://127.0.0.1:3000")
    : options.serverUrl?.trim() || "http://127.0.0.1:3000";

  return {
    org,
    email,
    name,
    keyName,
    saveEnv,
    envFile,
    serverUrl
  };
}

async function promptRequiredText(message: string, defaultValue: string): Promise<string> {
  const value = await text({ message, defaultValue, placeholder: defaultValue });
  if (isCancel(value)) {
    cancelBootstrap();
  }

  const trimmed = String(value).trim();
  if (!trimmed) {
    throw new Error(`${message} is required.`);
  }

  return trimmed;
}

async function promptOptionalText(message: string, defaultValue: string): Promise<string | undefined> {
  const value = await text({ message, defaultValue, placeholder: defaultValue });
  if (isCancel(value)) {
    cancelBootstrap();
  }

  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function promptConfirm(message: string, initialValue: boolean): Promise<boolean> {
  const value = await confirm({ message, initialValue });
  if (isCancel(value)) {
    cancelBootstrap();
  }

  return Boolean(value);
}

function cancelBootstrap(): never {
  cancel("Bootstrap cancelled. No changes written.");
  process.exit(0);
}

function normalizeOrgSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!slug) {
    throw new Error("Organization slug must contain at least one letter or number.");
  }

  return slug;
}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error(`Invalid email: ${value}`);
  }

  return email;
}

function normalizeServerUrl(value: string): string {
  const url = value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s]+$/.test(url)) {
    throw new Error(`Invalid server URL: ${value}`);
  }

  return url;
}
