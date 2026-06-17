import { ui } from "./ui.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface Spinner {
  stop(finalLine?: string): void;
}

/**
 * Lightweight terminal spinner. Animates on a TTY and clears its own line on
 * stop; on non-TTY (pipes, CI) it prints the label once and does nothing else.
 */
export function startSpinner(text: string): Spinner {
  if (!process.stdout.isTTY) {
    console.log(ui.muted(text));
    return { stop: (finalLine) => finalLine && console.log(finalLine) };
  }

  let frame = 0;
  process.stdout.write("\x1B[?25l"); // hide cursor

  // Restore the cursor if the process is interrupted mid-spin (Ctrl+C) or
  // exits, not just on a normal stop(); otherwise the terminal is left with an
  // invisible cursor until reset.
  const showCursor = (): void => {
    process.stdout.write("\x1B[?25h");
  };
  const onExit = (): void => showCursor();
  const onSigint = (): void => {
    showCursor();
    process.exit(130);
  };
  process.once("exit", onExit);
  process.once("SIGINT", onSigint);

  const render = (): void => {
    process.stdout.write(`\r${ui.info(FRAMES[frame])} ${ui.muted(text)}`);
  };
  render(); // paint frame 0 now so the glyph is visible even before the first tick
  const timer = setInterval(() => {
    frame = (frame + 1) % FRAMES.length;
    render();
  }, 80);

  return {
    stop(finalLine?: string): void {
      clearInterval(timer);
      process.removeListener("exit", onExit);
      process.removeListener("SIGINT", onSigint);
      process.stdout.write("\r\x1B[K\x1B[?25h"); // clear line, show cursor
      if (finalLine) {
        console.log(finalLine);
      }
    }
  };
}
