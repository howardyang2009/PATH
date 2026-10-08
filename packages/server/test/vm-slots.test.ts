import { describe, expect, it } from "vitest";
import { createVmSlots } from "../src/sandbox/vm-slots.js";

describe("createVmSlots", () => {
  it("grants up to the cap, then hands a freed slot to the oldest waiter", async () => {
    const slots = createVmSlots(1);
    const first = await slots.take().slot;
    const second = slots.take();
    const third = slots.take();
    let granted = "";
    second.slot.then(() => (granted ||= "second"));
    third.slot.then(() => (granted ||= "third"));

    await Promise.resolve();
    expect(granted).toBe("");
    first?.();
    first?.();
    await second.slot;
    expect(granted).toBe("second");
  });

  it("resolves a cancelled waiter with null and skips it", async () => {
    const slots = createVmSlots(1);
    const first = await slots.take().slot;
    const cancelled = slots.take();
    const next = slots.take();
    cancelled.cancel();

    expect(await cancelled.slot).toBeNull();
    first?.();
    expect(await next.slot).toBeTypeOf("function");
  });
});

describe("createVmSlots per user", () => {
  it("keeps a user's second launch queued while other users' launches start", async () => {
    const slots = createVmSlots(3);
    const aliceFirst = await slots.take("alice", 1).slot;
    const aliceSecond = slots.take("alice", 1);
    const bob = slots.take("bob", 1);
    let aliceStarted = false;
    aliceSecond.slot.then(() => (aliceStarted = true));

    expect(await bob.slot).toBeTypeOf("function");
    expect(aliceStarted).toBe(false);
    aliceFirst?.();
    expect(await aliceSecond.slot).toBeTypeOf("function");
  });

  it("gives a freed slot to the oldest launch of a user with nothing running", async () => {
    const slots = createVmSlots(2);
    const alice = await slots.take("alice", 1).slot;
    const bob = await slots.take("bob", 1).slot;
    const aliceAgain = slots.take("alice", 1);
    const carol = slots.take("carol", 1);
    let granted = "";
    aliceAgain.slot.then(() => (granted ||= "alice"));
    carol.slot.then(() => (granted ||= "carol"));

    bob?.();
    await carol.slot;
    expect(granted).toBe("carol");
    alice?.();
    expect(await aliceAgain.slot).toBeTypeOf("function");
  });
});
