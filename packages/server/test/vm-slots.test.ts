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
