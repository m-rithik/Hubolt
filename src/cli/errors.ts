import { ZodError } from "zod";
import { ui } from "./ui.js";

export function runSafely(fn: () => void): void {
  try {
    fn();
  } catch (error) {
    handleCliError(error);
  }
}

export async function runSafelyAsync(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    handleCliError(error);
  }
}

export function handleCliError(error: unknown): void {
  if (error instanceof ZodError) {
    console.error(ui.error("Invalid Hubolt configuration:"));
    for (const issue of error.issues) {
      console.error(`- ${issue.path.join(".") || "root"}: ${issue.message}`);
    }
  } else if (error instanceof Error) {
    console.error(ui.error(error.message));
  } else {
    console.error(ui.error("Unknown Hubolt error."));
  }

  process.exitCode = 1;
}
