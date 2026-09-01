import type { AcquireLockInput, AcquireLockResult, HeartbeatResult, LeaseOpInput, WorkflowLease } from "@path/client-core";
import { describe, expect, it } from "vitest";
import { LeaseController, type LeaseMap, type LeaseScheduler } from "../src/lease-client.js";

/** A lease with a given expiry — the rest of the fields never matter to the client. */
function lease(expiresAt: string): WorkflowLease {
  return { session_id: "s1", acquired_at: "t0", heartbeat_at: "t0", expires_at: expiresAt };
}

/** A programmable lock client: queue per-path acquire/heartbeat outcomes and record every call. */
class FakeLockClient {
  acquireCalls: AcquireLockInput[] = [];
  heartbeatCalls: LeaseOpInput[] = [];
  releaseCalls: LeaseOpInput[] = [];
  private acquireQueue = new Map<string, AcquireLockResult[]>();
  private acquireThrow = new Map<string, unknown>();
  private heartbeatQueue = new Map<string, HeartbeatResult[]>();

  onAcquire(path: string, ...results: AcquireLockResult[]): this {
    this.acquireQueue.set(path, [...(this.acquireQueue.get(path) ?? []), ...results]);
    return this;
  }
  throwAcquire(path: string, error: unknown): this {
    this.acquireThrow.set(path, error);
    return this;
  }
  onHeartbeat(path: string, ...results: HeartbeatResult[]): this {
    this.heartbeatQueue.set(path, [...(this.heartbeatQueue.get(path) ?? []), ...results]);
    return this;
  }

  acquireLock = async (input: AcquireLockInput): Promise<AcquireLockResult> => {
    this.acquireCalls.push(input);
    if (this.acquireThrow.has(input.workflowPath)) throw this.acquireThrow.get(input.workflowPath);
    const q = this.acquireQueue.get(input.workflowPath) ?? [];
    return q.shift() ?? { status: "granted", lease: lease("t30") };
  };
  heartbeatLock = async (input: LeaseOpInput): Promise<HeartbeatResult> => {
    this.heartbeatCalls.push(input);
    const q = this.heartbeatQueue.get(input.workflowPath) ?? [];
    return q.shift() ?? { status: "renewed", lease: lease("t40") };
  };
  releaseLock = async (input: LeaseOpInput): Promise<void> => {
    this.releaseCalls.push(input);
  };
}

/** A scheduler whose one heartbeat callback is fired by hand, so a "beat" is deterministic. */
function manualScheduler(): { scheduler: LeaseScheduler; beats: Map<unknown, () => void>; fire: (handle: unknown) => void } {
  const beats = new Map<unknown, () => void>();
  let next = 1;
  const scheduler: LeaseScheduler = {
    setInterval: (callback) => {
      const handle = next++;
      beats.set(handle, callback);
      return handle;
    },
    clearInterval: (handle) => {
      beats.delete(handle);
    },
  };
  return { scheduler, beats, fire: (handle) => beats.get(handle)?.() };
}

/** Let all queued microtasks (the awaited acquire/heartbeat replies) settle. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Collect the state snapshots emitted while running `run`. */
function watch(controller: LeaseController): LeaseMap[] {
  const seen: LeaseMap[] = [];
  controller.subscribe((map) => seen.push(map));
  return seen;
}

describe("LeaseController (#371 edit-lock client)", () => {
  it("acquires a lease for each open path and starts beating", async () => {
    const client = new FakeLockClient().onAcquire("a.workflow.json", { status: "granted", lease: lease("t30") });
    const { scheduler, beats } = manualScheduler();
    const controller = new LeaseController(client, "s1", scheduler);

    controller.reconcile(["a.workflow.json"]);
    await flush();

    expect(client.acquireCalls).toEqual([{ workflowPath: "a.workflow.json", sessionId: "s1" }]);
    expect(controller.snapshot().get("a.workflow.json")).toEqual({ phase: "held", expiresAt: "t30" });
    expect(beats.size).toBe(1); // a heartbeat timer is running
  });

  it("beats on the timer and renews the expiry", async () => {
    const client = new FakeLockClient()
      .onAcquire("a", { status: "granted", lease: lease("t30") })
      .onHeartbeat("a", { status: "renewed", lease: lease("t60") });
    const { scheduler, beats, fire } = manualScheduler();
    const controller = new LeaseController(client, "s1", scheduler);

    controller.reconcile(["a"]);
    await flush();
    fire([...beats.keys()][0]);
    await flush();

    expect(client.heartbeatCalls).toEqual([{ workflowPath: "a", sessionId: "s1" }]);
    expect(controller.snapshot().get("a")).toEqual({ phase: "held", expiresAt: "t60" });
  });

  it("a 409 on acquire is held-by-other with the holder's expiry — no beat", async () => {
    const client = new FakeLockClient().onAcquire("a", { status: "held-by-other", expiresAt: "t99" });
    const { scheduler, beats } = manualScheduler();
    const controller = new LeaseController(client, "s1", scheduler);

    controller.reconcile(["a"]);
    await flush();

    expect(controller.snapshot().get("a")).toEqual({ phase: "held-by-other", expiresAt: "t99" });
    expect(beats.size).toBe(0);
  });

  it("takeover re-acquires with takeover:true and, on grant, starts beating", async () => {
    const client = new FakeLockClient().onAcquire(
      "a",
      { status: "held-by-other", expiresAt: "t99" },
      { status: "granted", lease: lease("t30") },
    );
    const { scheduler, beats } = manualScheduler();
    const controller = new LeaseController(client, "s1", scheduler);

    controller.reconcile(["a"]);
    await flush();
    controller.takeover("a");
    await flush();

    expect(client.acquireCalls[1]).toEqual({ workflowPath: "a", sessionId: "s1", takeover: true });
    expect(controller.snapshot().get("a")).toEqual({ phase: "held", expiresAt: "t30" });
    expect(beats.size).toBe(1);
  });

  it("a 409 on heartbeat loses the lease, stops beating, and re-acquire recovers it", async () => {
    const client = new FakeLockClient()
      .onAcquire("a", { status: "granted", lease: lease("t30") }, { status: "granted", lease: lease("t90") })
      .onHeartbeat("a", { status: "lost" });
    const { scheduler, beats, fire } = manualScheduler();
    const controller = new LeaseController(client, "s1", scheduler);

    controller.reconcile(["a"]);
    await flush();
    fire([...beats.keys()][0]);
    await flush();

    expect(controller.snapshot().get("a")).toEqual({ phase: "lost" });
    expect(beats.size).toBe(0); // the timer was cleared

    controller.reacquire("a");
    await flush();
    expect(controller.snapshot().get("a")).toEqual({ phase: "held", expiresAt: "t90" });
    expect(beats.size).toBe(1);
  });

  it("reconciling a path away releases its lease and clears its timer", async () => {
    const client = new FakeLockClient().onAcquire("a", { status: "granted", lease: lease("t30") });
    const { scheduler, beats } = manualScheduler();
    const controller = new LeaseController(client, "s1", scheduler);

    controller.reconcile(["a"]);
    await flush();
    controller.reconcile([]);
    await flush();

    expect(client.releaseCalls).toEqual([{ workflowPath: "a", sessionId: "s1" }]);
    expect(controller.snapshot().has("a")).toBe(false);
    expect(beats.size).toBe(0);
  });

  it("holds a second, independent lease when a descent opens a ref'd file", async () => {
    const client = new FakeLockClient();
    const { scheduler, beats } = manualScheduler();
    const controller = new LeaseController(client, "s1", scheduler);

    controller.reconcile(["parent"]);
    await flush();
    controller.reconcile(["parent", "child"]); // descend
    await flush();

    expect(client.acquireCalls.map((c) => c.workflowPath)).toEqual(["parent", "child"]);
    expect(controller.heldPaths().sort()).toEqual(["child", "parent"]);
    expect(beats.size).toBe(2); // both beat independently
  });

  it("a non-409 acquire failure surfaces as an error state", async () => {
    const client = new FakeLockClient().throwAcquire("a", new Error("not found"));
    const { scheduler } = manualScheduler();
    const controller = new LeaseController(client, "s1", scheduler);

    controller.reconcile(["a"]);
    await flush();

    expect(controller.snapshot().get("a")).toEqual({ phase: "error", message: "not found" });
  });

  it("dispose releases held leases and clears every timer", async () => {
    const client = new FakeLockClient();
    const { scheduler, beats } = manualScheduler();
    const controller = new LeaseController(client, "s1", scheduler);

    controller.reconcile(["a", "b"]);
    await flush();
    const seen = watch(controller);
    controller.dispose();

    expect(client.releaseCalls.map((c) => c.workflowPath).sort()).toEqual(["a", "b"]);
    expect(beats.size).toBe(0);
    expect(seen[seen.length - 1]?.size).toBe(0);
  });
});
