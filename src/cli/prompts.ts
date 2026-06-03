import { createInterface, type Interface } from "node:readline";

interface MutableInterface extends Interface {
  _writeToOutput?: (value: string) => void;
}

/**
 * Minimal interactive prompter built on node:readline (no extra dependency).
 *
 * Lines are buffered into a queue so sequential prompts work reliably for both
 * interactive TTY use and piped input (which otherwise races readline.question).
 * Secret input is masked on a TTY by suppressing echoed keystrokes.
 */
export class Prompter {
  private readonly rl: MutableInterface;
  private muted = false;
  private readonly queue: string[] = [];
  private pending: ((line: string) => void) | null = null;
  private closed = false;

  constructor() {
    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdin.isTTY === true
    }) as MutableInterface;

    if (process.stdout.isTTY) {
      const write = this.rl._writeToOutput?.bind(this.rl);
      if (write) {
        this.rl._writeToOutput = (value: string) => {
          if (!this.muted) {
            write(value);
          }
        };
      }
    }

    this.rl.on("line", (line) => {
      if (this.pending) {
        const resolve = this.pending;
        this.pending = null;
        resolve(line);
      } else {
        this.queue.push(line);
      }
    });

    this.rl.on("close", () => {
      this.closed = true;
      if (this.pending) {
        const resolve = this.pending;
        this.pending = null;
        resolve("");
      }
    });
  }

  ask(query: string, fallback = ""): Promise<string> {
    const suffix = fallback ? ` [${fallback}]` : "";
    process.stdout.write(`${query}${suffix}: `);
    return this.nextLine().then((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 ? trimmed : fallback;
    });
  }

  askSecret(query: string): Promise<string> {
    process.stdout.write(`${query}: `);
    this.muted = true;
    return this.nextLine().then((line) => {
      this.muted = false;
      process.stdout.write("\n");
      return line.trim();
    });
  }

  close(): void {
    this.rl.close();
  }

  private nextLine(): Promise<string> {
    const queued = this.queue.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    if (this.closed) {
      return Promise.resolve("");
    }
    return new Promise((resolve) => {
      this.pending = resolve;
    });
  }
}
