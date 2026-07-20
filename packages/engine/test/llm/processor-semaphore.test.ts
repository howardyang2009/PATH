import { describe, expect, it } from "vitest";
import { createProcessorSemaphore, DEFAULT_LLM_CONCURRENCY } from "../../src/llm/processor-semaphore.js";

/** A promise plus the handle that settles it — lets a test hold acquired slots open deliberately. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("processor-semaphore", () => {
  it("defaults to a cap of 4 concurrent LLM processors (mvp spec §5.5)", () => {
    expect(DEFAULT_LLM_CONCURRENCY).toBe(4);
  });

  it("never lets more than `limit` holders run at once", async () => {
    const semaphore = createProcessorSemaphore(2);
    let live = 0;
    let peak = 0;

    const hold = async () => {
      const release = await semaphore.acquire();
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live -= 1;
      release();
    };

    await Promise.all([hold(), hold(), hold(), hold(), hold()]);

    expect(peak).toBe(2);
    expect(live).toBe(0);
  });

  it("makes a waiter wait until a slot is released", async () => {
    const semaphore = createProcessorSemaphore(1);
    const release = await semaphore.acquire();

    let acquired = false;
    const waiter = semaphore.acquire().then((r) => {
      acquired = true;
      return r;
    });

    await Promise.resolve();
    expect(acquired).toBe(false);

    release();
    await waiter;
    expect(acquired).toBe(true);
  });

  it("hands waiting slots out in request order", async () => {
    const semaphore = createProcessorSemaphore(1);
    const first = await semaphore.acquire();
    const order: string[] = [];

    const second = semaphore.acquire().then((r) => {
      order.push("second");
      return r;
    });
    const third = semaphore.acquire().then((r) => {
      order.push("third");
      return r;
    });

    first();
    (await second)();
    (await third)();

    expect(order).toEqual(["second", "third"]);
  });

  it("releases the slot even when the holder's work throws", async () => {
    const semaphore = createProcessorSemaphore(1);
    const gate = deferred();

    const failing = (async () => {
      const release = await semaphore.acquire();
      try {
        await gate.promise;
        throw new Error("processor blew up");
      } finally {
        release();
      }
    })();

    gate.resolve();
    await expect(failing).rejects.toThrow("processor blew up");

    // The cap is engine-wide and long-lived: a leaked slot would deadlock every later prompt step.
    const release = await semaphore.acquire();
    release();
  });

  it("ignores a double release, so one holder can never widen the cap", async () => {
    const semaphore = createProcessorSemaphore(1);
    const release = await semaphore.acquire();
    release();
    release();

    let live = 0;
    let peak = 0;
    const hold = async () => {
      const r = await semaphore.acquire();
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((res) => setTimeout(res, 5));
      live -= 1;
      r();
    };
    await Promise.all([hold(), hold()]);

    expect(peak).toBe(1);
  });
});
