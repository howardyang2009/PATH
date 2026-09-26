/** Engine-wide Processor concurrency cap (mvp spec §5.5): ~400 MB RSS per live Agent SDK session makes
 * memory, not CPU, the ceiling. Overridable in engine config; binary steps are uncapped. */
export const DEFAULT_PROCESSOR_CONCURRENCY = 4;

/** Returns a slot to the semaphore. Idempotent — a double release must not widen the cap. */
export type ReleaseSlot = () => void;

export interface ProcessorSemaphore {
  /** Resolves once a processor slot is free; the caller releases it when its processor is torn down. */
  acquire(): Promise<ReleaseSlot>;
}

/** Counting semaphore with FIFO hand-off; one instance spans an entire run tree, nested parallels
 * included (mvp spec §5.5), so a branch whose next prompt step needs a slot simply waits. */
export function createProcessorSemaphore(limit: number): ProcessorSemaphore {
  let available = limit;
  const waiting: ((release: ReleaseSlot) => void)[] = [];

  function makeRelease(): ReleaseSlot {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = waiting.shift();
      if (next) {
        next(makeRelease());
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
