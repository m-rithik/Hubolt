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
  const timer = setInterval(() => {
    frame = (frame + 1) % FRAMES.length;
    process.stdout.write(`\r${ui.info(FRAMES[frame])} ${ui.muted(text)}`);
  }, 80);

  return {
    stop(finalLine?: string): void {
      clearInterval(timer);
      process.stdout.write("\r\x1B[K\x1B[?25h"); // clear line, show cursor
      if (finalLine) {
        console.log(finalLine);
      }
    }
  };
}
