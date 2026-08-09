import type { LogEvent } from "@path/schema";
import { describe, expect, it, vi } from "vitest";
import { createLiveLogBackend } from "../src/live-log-backend.js";
import { RunEventHub } from "../src/run-event-hub.js";

const event = (seq: number): LogEvent => ({
  type: "step-finished",
  seq,
  ts: "2026-07-27T10:00:00.000Z",
  run_id: "root-1",
  node_id: null,
  node_name: null,
  status: "succeeded",
});

describe("RunEventHub", () => {
  it("fans an event out to every subscriber of that run, and to no other run's", () => {
    const hub = new RunEventHub();
    hub.open("root-1");
    hub.open("root-2");

    const a = vi.fn();
    const b = vi.fn();
    const other = vi.fn();
    hub.subscribe("root-1", a, vi.fn());
    hub.subscribe("root-1", b, vi.fn());
    hub.subscribe("root-2", other, vi.fn());

    hub.publish("root-1", event(1));

    expect(a).toHaveBeenCalledWith(event(1));
    expect(b).toHaveBeenCalledWith(event(1));
    expect(other).not.toHaveBeenCalled();
  });

  /**
   * The tri-state the SSE route depends on: `null` means no live channel, and the route then reads
   * the run store to tell an already-finished run (end-of-stream) from an unknown one (404).
   */
  it("returns null from subscribe when a run has no open channel", () => {
    const hub = new RunEventHub();
    expect(hub.subscribe("never-started", vi.fn(), vi.fn())).toBeNull();

    hub.open("root-1");
    expect(hub.subscribe("root-1", vi.fn(), vi.fn())).not.toBeNull();

    hub.close("root-1");
    expect(hub.subscribe("root-1", vi.fn(), vi.fn())).toBeNull();
  });

  it("notifies close listeners once and stops delivering", () => {
    const hub = new RunEventHub();
    hub.open("root-1");
    const onEvent = vi.fn();
    const onClose = vi.fn();
    hub.subscribe("root-1", onEvent, onClose);

    hub.close("root-1");

    expect(onClose).toHaveBeenCalledOnce();
    hub.publish("root-1", event(1));
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("stops delivering to an unsubscribed listener without disturbing the others", () => {
    const hub = new RunEventHub();
    hub.open("root-1");
    const gone = vi.fn();
    const stays = vi.fn();
    const unsubscribe = hub.subscribe("root-1", gone, vi.fn());
    hub.subscribe("root-1", stays, vi.fn());

    unsubscribe?.();
    hub.publish("root-1", event(1));

    expect(gone).not.toHaveBeenCalled();
    expect(stays).toHaveBeenCalledOnce();
  });

  it("does not fire an unsubscribed listener's close callback", () => {
    const hub = new RunEventHub();
    hub.open("root-1");
    const onClose = vi.fn();
    const unsubscribe = hub.subscribe("root-1", vi.fn(), onClose);

    unsubscribe?.();
    hub.close("root-1");

    expect(onClose).not.toHaveBeenCalled();
  });

  // What makes the backstop in post-runs' `.finally()` safe to add alongside the engine-driven
  // close on the normal path (#74).
  it("is idempotent on close, and tolerates closing or publishing to a run it never opened", () => {
    const hub = new RunEventHub();
    hub.open("root-1");
    const onClose = vi.fn();
    hub.subscribe("root-1", vi.fn(), onClose);

    hub.close("root-1");
    hub.close("root-1");
    expect(onClose).toHaveBeenCalledOnce();

    expect(() => hub.close("never-opened")).not.toThrow();
    expect(() => hub.publish("never-opened", event(1))).not.toThrow();
  });

  it("opening an already-open channel keeps its subscribers", () => {
    const hub = new RunEventHub();
    hub.open("root-1");
    const onEvent = vi.fn();
    hub.subscribe("root-1", onEvent, vi.fn());

    hub.open("root-1");
    hub.publish("root-1", event(1));

    expect(onEvent).toHaveBeenCalledOnce();
  });
});

describe("createLiveLogBackend", () => {
  it("opens, publishes to, and closes the channel for its root run", async () => {
    const hub = new RunEventHub();
    const backend = createLiveLogBackend(hub);
    const onEvent = vi.fn();
    const onClose = vi.fn();

    await backend.open({ runId: "root-1", format: "path/log@0" });
    hub.subscribe("root-1", onEvent, onClose);
    await backend.write(event(1));
    await backend.close();

    expect(onEvent).toHaveBeenCalledWith(event(1));
    expect(onClose).toHaveBeenCalledOnce();
    expect(hub.subscribe("root-1", vi.fn(), vi.fn())).toBeNull();
  });

  /**
   * A live-forwarding backend must never disrupt execution: a backend write failure fails the run
   * (mvp spec §8.2), so nothing here may throw — including when it is driven out of order.
   */
  it("drops a write or close that arrives before open, rather than throwing", async () => {
    const hub = new RunEventHub();
    const backend = createLiveLogBackend(hub);

    await expect(backend.write(event(1))).resolves.toBeUndefined();
    await expect(backend.close()).resolves.toBeUndefined();
  });
});
