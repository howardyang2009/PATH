import { createInterface } from "node:readline/promises";
import type { WorkerOverrides } from "../run-options.js";

export interface CliIo {
  log(message: string): void;
  error(message: string): void;
  /** Ask a yes/no question; `undefined` means the surface cannot ask, which counts as "not
   * confirmed". */
  confirm?(question: string): Promise<boolean> | undefined;
}

/** Collaborators the CLI would otherwise construct; the acceptance run injects a scripted LLM
 * worker. */
export interface RunOverrides {
  /** Replace named `(type, worker)` pairs in the scanned registry, forwarded to `runWorkflow`
   * verbatim. */
  workerOverrides?: WorkerOverrides;
  /** How a forced second `^C` leaves the process — defaults to `process.exit(130)`; tests
   * substitute their own. */
  forceExit?: (code: number) => void;
}

export const consoleIo: CliIo = {
  log: (message) => console.log(message),
  error: (message) => console.error(message),
  // Only an interactive stdin can answer; `y`/`yes` (any case) is the only accepted yes.
  confirm: (question) => {
    if (!process.stdin.isTTY) return undefined;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return rl
      .question(`${question} `)
      .then((answer) => /^y(es)?$/i.test(answer.trim()))
      .finally(() => rl.close());
  },
};
