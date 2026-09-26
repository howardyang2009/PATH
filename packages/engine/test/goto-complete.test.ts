import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPassRun, type RunRecord, type WorkflowFile } from "@path/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkerDescriptor } from "../src/plugin/seam.js";
import { openProject, type Project } from "../src/project.js";
import type { Observation, RunObserver } from "../src/run-observer.js";
import { stampNames } from "./stamp-names.js";

/**
 * Complete across goto passes (docs/spec/goto.md §8.2, ADR 0060; §11 rows G-E-12 and G-E-13), driven
 * through `Project.complete` over a real store: a `person-activity` leaf parks the run inside a pass,
 * and each Complete re-enters the one `running` pass in place without re-walking the closed ones.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "path-engine-goto-complete-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function open(): Project {
  const opened = openProject(dir);
  if (!opened.success) throw new Error(`${opened.kind}: ${opened.error}`);
  return opened.project;
}

/** A `prompt` worker that answers `<prompt>-<visit>` and records every execution in `ran`. */
function scripted(ran: string[]) {
  const visits = new Map<string, number>();
  const worker: WorkerDescriptor = {
    meters: false,
    needsProcessorSlot: true,
    async run(request) {
      const prompt = String((request.fields as { prompt: string }).prompt);
      ran.push(prompt);
      const visit = (visits.get(prompt) ?? 0) + 1;
      visits.set(prompt, visit);
      return { status: "succeeded", output: `${prompt}-${visit}` };
    },
  };
  return { prompt: { anthropic: worker } };
}

function step(name: string) {
  return { type: "prompt", id: name, prompt: name };
}

/**
 * `[a, review, guard]`: `review` is a person-activity leaf publishing its output as `last`; the guard
 * jumps back to `target` while `last` is `"again"`, else runs `done`. `wrapReview` nests `review` in a
 * `stage` sequence.
 */
function loop(
  opts: { target?: string; maxJumps?: number; wrapReview?: boolean } = {},
): WorkflowFile {
  const review = {
    type: "person-activity",
    id: "review",
    description: "review it",
    publish: { last: "${output}" },
  };
  return stampNames({
    format: "path/workflow@5",
    id: "wf-id",
    name: "reviews",
    config: { model: "m" },
    body: [
      step("a"),
      opts.wrapReview ? { type: "sequence", id: "stage", body: [review] } : review,
      {
        type: "branch",
        id: "guard",
        arms: [
          {
            when: { type: "one-of", path: "context.last", values: ["again"] },
            node: {
              type: "goto",
              id: "check",
              target: opts.target ?? "review",
              max_jumps: opts.maxJumps ?? 3,
            },
          },
        ],
        else: step("done"),
      },
    ],
  } as unknown as WorkflowFile);
}

function capture(): { observer: RunObserver; all: Observation[] } {
  const all: Observation[] = [];
  return {
    observer: { observe: async (o: Observation) => void all.push(o) } as unknown as RunObserver,
    all,
  };
}

function passesOf(runs: RunRecord[]) {
  const root = runs.find((r) => r.parentRunId === null)!;
  return runs
    .filter((r) => r.parentRunId === root.runId && isPassRun(r))
    .sort((a, b) => a.pass! - b.pass!)
    .map((p) => ({
      pass: p.pass,
      opener: p.nodeName,
      status: p.status,
      children: runs.filter((r) => r.parentRunId === p.runId),
    }));
}

function awaitingLeaf(project: Project, rootRunId: string): RunRecord {
  const leaf = project.archive.tree(rootRunId)!.runs.find((r) => r.status === "awaiting");
  if (!leaf) throw new Error("no awaiting leaf in tree");
  return leaf;
}

/** Launches `loop()` and Completes the first review with "again", so the run parks in pass 2. */
async function parkedInPass2(project: Project, file: WorkflowFile, ran: string[]): Promise<string> {
  await project.run(file, dir, { workerOverrides: scripted(ran) });
  const rootRunId = project.archive.listRoots().at(-1)!.runId;
  const first = await project.complete(file, awaitingLeaf(project, rootRunId).runId, "again", dir, {
    workerOverrides: scripted(ran),
  });
  if (!first.ok) throw new Error(`expected ok, got ${JSON.stringify(first)}`);
  expect(first.status).toBe("awaiting");
  expect(passesOf(project.archive.tree(rootRunId)!.runs).map((p) => [p.pass, p.status])).toEqual([
    [1, "succeeded"],
    [2, "running"],
  ]);
  return rootRunId;
}

/** The goto events of one observation stream, as short lines. */
function gotoEvents(all: Observation[]): string[] {
  return all.flatMap((o) => {
    if (o.type === "pass-started") return [`pass-started ${o.pass}`];
    if (o.type === "goto-taken") return [`goto-taken ${o.jump}/${o.maxJumps} pass ${o.pass}`];
    if (o.type === "goto-exhausted") return [`goto-exhausted ${o.maxJumps} pass ${o.pass}`];
    return [];
  });
}

describe("goto — Complete follows the record across passes (spec §8.2)", () => {
  it("G-E-12: Complete re-enters the running pass 2 in place, emits nothing for closed passes, and may jump again", async () => {
    const project = open();
    try {
      const ran: string[] = [];
      const file = loop();
      const rootRunId = await parkedInPass2(project, file, ran);

      const { observer, all } = capture();
      const second = await project.complete(
        file,
        awaitingLeaf(project, rootRunId).runId,
        "again",
        dir,
        {
          workerOverrides: scripted(ran),
          extraObservers: [observer],
        },
      );
      if (!second.ok) throw new Error(`expected ok, got ${JSON.stringify(second)}`);
      expect(second.status).toBe("awaiting");
      // No event for pass 1 or a second pass 2: the only goto events are the new jump and pass 3.
      // The jump is the goto's second: pass 2's row already counts one.
      expect(gotoEvents(all)).toEqual(["goto-taken 2/3 pass 3", "pass-started 3"]);

      const passes = passesOf(project.archive.tree(rootRunId)!.runs);
      expect(passes.map((p) => [p.pass, p.opener, p.status])).toEqual([
        [1, null, "succeeded"],
        [2, "check", "succeeded"],
        [3, "check", "running"],
      ]);
      // Pass 2 was re-entered in place: its leaf completed, nothing in it re-ran or doubled.
      expect(passes[1]!.children.map((r) => [r.nodeName, r.status])).toEqual([
        ["review", "succeeded"],
      ]);

      const last = await project.complete(file, awaitingLeaf(project, rootRunId).runId, "ok", dir, {
        workerOverrides: scripted(ran),
      });
      if (!last.ok) throw new Error(`expected ok, got ${JSON.stringify(last)}`);
      expect(last.status).toBe("succeeded");
      // `a` ran once at launch; closed passes were never re-walked.
      expect(ran).toEqual(["a", "done"]);
      expect(
        passesOf(project.archive.tree(rootRunId)!.runs).map((p) => [p.pass, p.status]),
      ).toEqual([
        [1, "succeeded"],
        [2, "succeeded"],
        [3, "succeeded"],
      ]);
    } finally {
      project.close();
    }
  });

  it("Complete re-enters a pass whose goto target is a sequence: the sequence's first leaf is the pass's first row", async () => {
    const project = open();
    try {
      const ran: string[] = [];
      const file = loop({ target: "stage", wrapReview: true });
      const rootRunId = await parkedInPass2(project, file, ran);

      const done = await project.complete(file, awaitingLeaf(project, rootRunId).runId, "ok", dir, {
        workerOverrides: scripted(ran),
      });
      if (!done.ok) throw new Error(`expected ok, got ${JSON.stringify(done)}`);
      expect(done.error).toBeUndefined();
      expect(done.status).toBe("succeeded");
      expect(ran).toEqual(["a", "done"]);
      expect(
        passesOf(project.archive.tree(rootRunId)!.runs).map((p) => [p.pass, p.status]),
      ).toEqual([
        [1, "succeeded"],
        [2, "succeeded"],
      ]);
    } finally {
      project.close();
    }
  });

  it("counts jumps from the pass rows already present: a goto with max_jumps 1 is exhausted after Complete", async () => {
    const project = open();
    try {
      const file = loop({ maxJumps: 1 });
      const rootRunId = await parkedInPass2(project, file, []);

      const { observer, all } = capture();
      const done = await project.complete(
        file,
        awaitingLeaf(project, rootRunId).runId,
        "again",
        dir,
        {
          workerOverrides: scripted([]),
          extraObservers: [observer],
        },
      );
      if (!done.ok) throw new Error(`expected ok, got ${JSON.stringify(done)}`);
      expect(done.status).toBe("failed");
      expect(done.error).toBe('goto "check": max_jumps (1) exhausted');
      expect(gotoEvents(all)).toEqual(["goto-exhausted 1 pass 2"]);
    } finally {
      project.close();
    }
  });

  it("G-E-13: Complete after the opening goto's target was edited fails as diverged; a later Resume reuses the leaf's output", async () => {
    const project = open();
    try {
      const rootRunId = await parkedInPass2(project, loop(), []);
      const leaf = awaitingLeaf(project, rootRunId);
      const edited = loop({ target: "a" });

      const done = await project.complete(edited, leaf.runId, "fine", dir, {
        workerOverrides: scripted([]),
      });
      if (!done.ok) throw new Error(`expected ok, got ${JSON.stringify(done)}`);
      expect(done.status).toBe("failed");
      expect(done.error).toBe(
        'Complete replay diverged: pass 2 was opened by goto "check" whose target is now "a", recorded "review"',
      );

      const tree = project.archive.tree(rootRunId)!;
      expect(tree.root!.status).toBe("failed");
      // The leaf's output is committed despite the divergence.
      const settled = tree.runs.find((r) => r.runId === leaf.runId)!;
      expect(settled.status).toBe("succeeded");
      expect(tree.blob(leaf.runId, "output")).toBe("fine");
      expect(passesOf(tree.runs).map((p) => [p.pass, p.status])).toEqual([
        [1, "succeeded"],
        [2, "failed"],
      ]);

      // A Resume over the edited file pairs pass 2 (same opening goto) and reuses the committed review.
      const ran: string[] = [];
      const resumed = await project.resume(edited, rootRunId, dir, {
        workerOverrides: scripted(ran),
      });
      if (!resumed.found) throw new Error("expected found:true");
      expect(resumed.status).toBe("succeeded");
      expect(ran).toEqual(["a", "done"]);
    } finally {
      project.close();
    }
  });
});
