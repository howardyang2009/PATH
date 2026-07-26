import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LogEventSchema } from "../../src/logging/log-event.js";
import { createNdjsonBackend, readNdjsonLog } from "../../src/logging/ndjson-backend.js";
import { rootRunTreeDir } from "../../src/persistence/paths.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "path-engine-ndjson-backend-test-"));
}

function readLog(projectDir: string, rootRunId: string): string[] {
  const path = join(rootRunTreeDir(projectDir, rootRunId), "run.log");
  return readFileSync(path, "utf8").trimEnd().split("\n");
}

describe("createNdjsonBackend", () => {
  it("opens run.log at the run-tree root with the log-header line, then one JSON line per event", async () => {
    const projectDir = tmp();
    try {
      const backend = createNdjsonBackend(projectDir);
      await backend.open({ runId: "root-1", format: "path/log@0" });
      await backend.write({ type: "step-finished", seq: 1, ts: "t", run_id: "root-1", node_id: null, status: "succeeded" });
      await backend.close();

      const lines = readLog(projectDir, "root-1");
      expect(JSON.parse(lines[0]!)).toEqual({ type: "log-header", format: "path/log@0", run_id: "root-1" });
      // Every non-header line validates against the event schema.
      expect(() => LogEventSchema.parse(JSON.parse(lines[1]!))).not.toThrow();
      expect(lines).toHaveLength(2);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("preserves seq order across many events", async () => {
    const projectDir = tmp();
    try {
      const backend = createNdjsonBackend(projectDir);
      await backend.open({ runId: "root-1", format: "path/log@0" });
      for (let seq = 1; seq <= 5; seq += 1) {
        await backend.write({ type: "step-finished", seq, ts: "t", run_id: "root-1", node_id: null, status: "succeeded" });
      }
      await backend.close();

      const seqs = readLog(projectDir, "root-1")
        .slice(1)
        .map((line) => JSON.parse(line).seq);
      expect(seqs).toEqual([1, 2, 3, 4, 5]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

describe("readNdjsonLog", () => {
  it("reads the narrative back in seq order, skipping the log-header line", async () => {
    const projectDir = tmp();
    try {
      const backend = createNdjsonBackend(projectDir);
      await backend.open({ runId: "root-1", format: "path/log@0" });
      for (let seq = 1; seq <= 3; seq += 1) {
        await backend.write({ type: "step-finished", seq, ts: "t", run_id: "root-1", node_id: null, status: "succeeded" });
      }
      await backend.close();

      const events = readNdjsonLog(projectDir, "root-1");
      expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
      for (const event of events) expect(() => LogEventSchema.parse(event)).not.toThrow();
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("replays a v0.3-era log whose run-cancelled line has no cause field (#52)", () => {
    // The dogfood logs under docs/dogfood/.path/ were written before `cause` existed; replay
    // validates every line, so an old log must still read back — as a sibling-failed cancellation.
    const projectDir = tmp();
    try {
      const dir = rootRunTreeDir(projectDir, "root-1");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "run.log"),
        [
          JSON.stringify({ type: "log-header", format: "path/log@0", run_id: "root-1" }),
          JSON.stringify({ type: "run-cancelled", seq: 1, ts: "t", run_id: "step-1", node_id: "sleeper", cause_run_id: "step-2" }),
          "",
        ].join("\n"),
      );

      const events = readNdjsonLog(projectDir, "root-1");
      expect(events).toEqual([
        { type: "run-cancelled", seq: 1, ts: "t", run_id: "step-1", node_id: "sleeper", cause: "sibling-failed", cause_run_id: "step-2" },
      ]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("returns [] when run.log doesn't exist (backend disabled, or no run at this id)", () => {
    const projectDir = tmp();
    try {
      expect(readNdjsonLog(projectDir, "no-such-run")).toEqual([]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
