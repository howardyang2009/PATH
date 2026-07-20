/**
 * The engine-wide cap on concurrent LLM processors (mvp spec §5.5, §7): ~400 MB of RSS per live
 * Agent SDK session means memory, not CPU, is the ceiling — 4 processors is ~1.5 GB, comfortable
 * on a 16 GB machine. Overridable in engine config; binary steps are uncapped.
 */
export const DEFAULT_LLM_CONCURRENCY = 4;

/** Returns a slot to the semaphore. Idempotent — calling it twice must not widen the cap. */
export type ReleaseSlot = () => void;

export interface ProcessorSemaphore {
  /** Resolves once a processor slot is free; the caller releases it when its processor is torn down. */
  acquire(): Promise<ReleaseSlot>;
}

/**
 * A counting semaphore with FIFO hand-off. One instance spans an entire run tree — nested
 * workflows and nested parallels included (mvp spec §5.5) — so a branch whose next prompt step
 * cannot get a slot simply waits.
 */
export function createProcessorSemaphore(limit: number): ProcessorSemaphore {
  let available = limit;
  const waiting: ((release: ReleaseSlot) => void)[] = [];

  function makeRelease(): ReleaseSlot {
    let released = false;
    return () => {
      if (released) return; // a second release would hand out a slot this holder never held
      released = true;
      const next = waiting.shift();
      if (next) {
        next(makeRelease()); // hand the slot straight to the waiter — `available` stays spoken for
        return;
      }
      available += 1;
    };
  }

  return {
    acquire() {
      if (available > 0) {
        available -= 1;
        return Promise.resolve(makeRelease());
      }
      return new Promise<ReleaseSlot>((resolve) => {
        waiting.push(resolve);
      });
    },
  };
}
