import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunRecord, WorkflowFile } from "@path/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireCompleteLease } from "../src/persistence/complete-lease.js";
import type { WorkerDescriptor } from "../src/plugin/seam.js";
import { openProject, type Project } from "../src/project.js";
import { stampNames } from "./stamp-names.js";

/**
 * Complete as a replay-from-root engine invocation over the appendable tree (#484, ADR 0039/0041).
 * These drive a **real** `Project` — the tree must actually exist as rows and blobs for the replay to
 * re-enter it — through the person-activity plugin scanned from `plugin/step-plugin/`, which returns
 * `{ status: "awaiting" }`. Each test launches a workflow that parks at a person-activity leaf, then
 * Completes the leaf and asserts on the persisted tree.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "path-engine-complete-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function open(): Project {
  const opened = openProject(dir);
  if (!opened.success) throw new Error(`${opened.kind}: ${opened.error}`);
  return opened.project;
}

/** A person-activity leaf: parks the run until Completed. `publish` exposes its output downstream. */
function person(
  id: string,
  opts?: { publish?: { [k: string]: string }; assignee?: string },
): WorkflowFile["body"][number] {
  return {
    type: "person-activity",
    id,
    name: id,
    description: `do ${id}`,
    ...(opts?.assignee ? { assignee: opts.assignee } : {}),
    ...(opts?.publish ? { publish: opts.publish } : {}),
  } as unknown as WorkflowFile["body"][number];
}

/** A trivial binary step that succeeds, so a tail after the parked leaf is observable as a real run. */
function marker(id: string): WorkflowFile["body"][number] {
  return {
    type: "binary",
    id,
    name: id,
    command: "node",
    args: ["-e", `process.stdout.write('${id}')`],
  };
}

function workflow(body: WorkflowFile["body"], output?: WorkflowFile["output"]): WorkflowFile {
  return stampNames({
    format: "path/workflow@5",
    id: "wf-complete",
    name: "complete-wf",
    body,
    ...(output ? { output } : {}),
  });
}

/** The one `awaiting` leaf of a tree — the parked person-activity step run. */
function awaitingLeaf(project: Project, rootRunId: string): RunRecord {
  const leaf = project.archive.tree(rootRunId)!.runs.find((r) => r.status === "awaiting");
  if (!leaf) throw new Error("no awaiting leaf in tree");
  return leaf;
}

function rowByNode(project: Project, rootRunId: string, nodeId: string): RunRecord | undefined {
  return project.archive.tree(rootRunId)!.runs.find((r) => r.nodeId === nodeId);
}

describe("launch parks at an awaiting leaf and tears down (ADR 0039)", () => {
  it("returns awaiting, leaves the root running and the leaf awaiting, and never runs the tail", async () => {
    const project = open();
    try {
      const wf = workflow([person("approve"), marker("after")]);
      const result = await project.run(wf, dir);

      // The engine tore down at the leaf: the run neither succeeded nor failed.
      expect(result.status).toBe("awaiting");

      const [root] = project.archive.listRoots();
      const tree = project.archive.tree(root!.runId)!;
      // Root stays running (non-terminal); the leaf sits at awaiting with no finish.
      expect(tree.root!.status).toBe("running");
      expect(awaitingLeaf(project, root!.runId).nodeId).toBe("approve");
      // The tail after the parked leaf never started — no row for it.
      expect(rowByNode(project, root!.runId, "after")).toBeUndefined();
    } finally {
      project.close();
    }
  });
});

describe("Complete replays from the root, resolves the leaf, and continues forward", () => {
  it("writes the leaf output, reuses the succeeded prefix, and runs the tail once in the same tree", async () => {
    const project = open();
    try {
      const wf = workflow(
        [person("approve", { publish: { decision: "${output}" } }), marker("after")],
        { result: "${context.decision}" },
      );
      await project.run(wf, dir);
      const [root] = project.archive.listRoots();
      const rootRunId = root!.runId;
      const leaf = awaitingLeaf(project, rootRunId);

      const done = await project.complete(wf, leaf.runId, { approved: true }, dir);
      expect(done.ok).toBe(true);
      if (!done.ok) throw new Error("expected ok");

      // Same tree — the Complete kept the root run id, minting no successor.
      expect(done.rootRunId).toBe(rootRunId);
      expect(done.status).toBe("succeeded");

      const tree = project.archive.tree(rootRunId)!;
      // The leaf flipped awaiting -> succeeded, its output written where the walk reused it.
      const settledLeaf = tree.runs.find((r) => r.runId === leaf.runId)!;
      expect(settledLeaf.status).toBe("succeeded");
      expect(tree.blob(leaf.runId, "output")).toEqual({ approved: true });
      // The tail ran forward in the same tree, and the root reached succeeded.
      expect(rowByNode(project, rootRunId, "after")!.status).toBe("succeeded");
      expect(tree.root!.status).toBe("succeeded");
      // The leaf's publish flowed into the workflow output.
      expect(tree.output()).toEqual({ result: { approved: true } });
    } finally {
      project.close();
    }
  });

  it("continues the per-root log stream: monotonic seq, no duplicates, tail narrated after the leaf", async () => {
    const project = open();
    try {
      const wf = workflow([person("approve"), marker("after")]);
      await project.run(wf, dir);
      const rootRunId = project.archive.listRoots()[0]!.runId;
      const seqsAfterLaunch = project.archive
        .tree(rootRunId)!
        .events()
        .map((e) => e.seq);
      const leaf = awaitingLeaf(project, rootRunId);

      await project.complete(wf, leaf.runId, { ok: true }, dir);

      const events = project.archive.tree(rootRunId)!.events();
      const seqs = events.map((e) => e.seq);
      // Strictly increasing and unique across launch + Complete — the re-invocation resumed the seq
      // rather than restarting it (which would collide on the (root, seq) key / duplicate run.log lines).
      expect(new Set(seqs).size).toBe(seqs.length);
      expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
      // The Complete appended events past where the launch stopped, and the tail is narrated.
      expect(seqs.length).toBeGreaterThan(seqsAfterLaunch.length);
      expect(events.some((e) => e.type === "step-started" && e.node_id === "after")).toBe(true);
    } finally {
      project.close();
    }
  });

  it("reconstructs an awaiting/Complete cycle from the log alone, carrying the leaf's assignee (#488)", async () => {
    const project = open();
    try {
      const wf = workflow([person("approve", { assignee: "alex" })]);
      await project.run(wf, dir);
      const rootRunId = project.archive.listRoots()[0]!.runId;
      const leaf = awaitingLeaf(project, rootRunId);

      // The park is narrated with the leaf's node id and its assignee, before any Complete.
      const parked = project.archive.tree(rootRunId)!.events();
      const awaiting = parked.find((e) => e.type === "step-awaiting");
      expect(awaiting).toMatchObject({
        type: "step-awaiting",
        node_id: "approve",
        assignee: "alex",
      });

      await project.complete(wf, leaf.runId, { ok: true }, dir);

      // The whole cycle for the leaf reads off the stream by its run id: started -> awaiting(assignee)
      // -> finished. The Complete re-invocation's step-finished carries a null node_id (no fresh
      // step-started re-seeds the per-invocation node map), so the run id is the reconstruction key
      // and the `step-awaiting` event is what bridges it to the node id + assignee.
      const forLeaf = project.archive
        .tree(rootRunId)!
        .events()
        .filter((e) => e.run_id === leaf.runId)
        .map((e) => e.type);
      expect(forLeaf).toEqual(["step-started", "step-awaiting", "step-finished"]);
      const finished = project.archive
        .tree(rootRunId)!
        .events()
        .find((e) => e.run_id === leaf.runId && e.type === "step-finished");
      expect(finished).toMatchObject({ type: "step-finished", status: "succeeded" });
    } finally {
      project.close();
    }
  });

  it("rejects a double-submit: a second Complete of the same leaf is not-awaiting", async () => {
    const project = open();
    try {
      const wf = workflow([person("approve"), marker("after")]);
      await project.run(wf, dir);
      const rootRunId = project.archive.listRoots()[0]!.runId;
      const leaf = awaitingLeaf(project, rootRunId);

      expect((await project.complete(wf, leaf.runId, { v: 1 }, dir)).ok).toBe(true);
      const second = await project.complete(wf, leaf.runId, { v: 2 }, dir);
      expect(second.ok).toBe(false);
      if (second.ok) throw new Error("expected rejection");
      expect(second.reason).toBe("not-awaiting");
    } finally {
      project.close();
    }
  });

  it("rejects an unknown leaf id as not-found", async () => {
    const project = open();
    try {
      const wf = workflow([person("approve")]);
      await project.run(wf, dir);
      const result = await project.complete(wf, "no-such-run", { v: 1 }, dir);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected rejection");
      expect(result.reason).toBe("not-found");
    } finally {
      project.close();
    }
  });

  it("rejects a Complete while the per-root lease is held (concurrent Complete → 409)", async () => {
    const project = open();
    try {
      const wf = workflow([person("approve")]);
      await project.run(wf, dir);
      const rootRunId = project.archive.listRoots()[0]!.runId;
      const leaf = awaitingLeaf(project, rootRunId);

      // Simulate a concurrent Complete already advancing this tree by holding its lease.
      const held = acquireCompleteLease(project.dir, rootRunId);
      expect(held).not.toBeNull();
      try {
        const rejected = await project.complete(wf, leaf.runId, { v: 1 }, dir);
        expect(rejected.ok).toBe(false);
        if (rejected.ok) throw new Error("expected rejection");
        expect(rejected.reason).toBe("lease-held");
      } finally {
        held!.release();
      }

      // With the lease freed, the same Complete now succeeds — the lease was the only blocker.
      expect((await project.complete(wf, leaf.runId, { v: 1 }, dir)).ok).toBe(true);
    } finally {
      project.close();
    }
  });
});

describe("park-at-join: parallel awaiting leaves run the tail exactly once (ADR 0041)", () => {
  it("parks again when a sibling is still awaiting, then runs the tail after the last Complete", async () => {
    const project = open();
    try {
      const wf = workflow([
        {
          type: "parallel",
          id: "par",
          name: "par",
          join: "collect",
          branches: [
            { type: "sequence", id: "ba", name: "ba", body: [person("pa_a")] },
            { type: "sequence", id: "bb", name: "bb", body: [person("pa_b")] },
          ],
        },
        marker("tail"),
      ]);
      await project.run(wf, dir);
      const rootRunId = project.archive.listRoots()[0]!.runId;

      // Two awaiting leaves coexist. Complete the first: the join is not satisfied, so the walk parks
      // again and the tail does not run.
      const leaves = project.archive.tree(rootRunId)!.runs.filter((r) => r.status === "awaiting");
      expect(leaves).toHaveLength(2);

      const first = await project.complete(wf, leaves[0]!.runId, { a: 1 }, dir);
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error("expected ok");
      expect(first.status).toBe("awaiting"); // park-at-join
      expect(rowByNode(project, rootRunId, "tail")).toBeUndefined();
      expect(project.archive.tree(rootRunId)!.root!.status).toBe("running");

      // Complete the second: the join is now satisfied, the tail runs, and the root succeeds — once.
      const second = await project.complete(wf, leaves[1]!.runId, { b: 2 }, dir);
      expect(second.ok).toBe(true);
      if (!second.ok) throw new Error("expected ok");
      expect(second.status).toBe("succeeded");
      const tailRows = project.archive.tree(rootRunId)!.runs.filter((r) => r.nodeId === "tail");
      expect(tailRows).toHaveLength(1);
      expect(tailRows[0]!.status).toBe("succeeded");
    } finally {
      project.close();
    }
  });
});

describe("Cancel works on a parked awaiting run (ADR 0041)", () => {
  it("transitions the awaiting leaf and its running ancestors to cancelled", async () => {
    const project = open();
    try {
      const wf = workflow([person("approve"), marker("after")]);
      await project.run(wf, dir);
      const rootRunId = project.archive.listRoots()[0]!.runId;
      const leaf = awaitingLeaf(project, rootRunId);

      expect(project.cancel(rootRunId)).toBe(true);

      const tree = project.archive.tree(rootRunId)!;
      expect(tree.root!.status).toBe("cancelled");
      expect(tree.runs.find((r) => r.runId === leaf.runId)!.status).toBe("cancelled");
      // A Complete of a cancelled leaf is refused — the tree is terminal.
      const afterCancel = await project.complete(wf, leaf.runId, { v: 1 }, dir);
      expect(afterCancel.ok).toBe(false);
    } finally {
      project.close();
    }
  });

  it("refuses to cancel a tree with no awaiting leaf (may be executing elsewhere)", async () => {
    const project = open();
    try {
      // A finished tree has no non-terminal work; cancel returns false so the route answers 409.
      const wf = workflow([marker("only")]);
      await project.run(wf, dir);
      const rootRunId = project.archive.listRoots()[0]!.runId;
      expect(project.cancel(rootRunId)).toBe(false);
    } finally {
      project.close();
    }
  });
});

describe("Complete replays the tail from the frozen launch default (ADR 0044, #519)", () => {
  // Two `prompt` worker names, each stubbed to a distinguishable output, so the worker the tail step
  // resolved to is readable off its recorded `worker_name`.
  function stubs(): { overrides: { prompt: { [name: string]: WorkerDescriptor } }; ran: string[] } {
    const ran: string[] = [];
    const make = (workerName: string): WorkerDescriptor => ({
      meters: false,
      needsProcessorSlot: true,
      run: async (request) => {
        ran.push(`${workerName}:${String(request.fields.prompt)}`);
        return { status: "succeeded", output: `${workerName}-ran` };
      },
    });
    return {
      overrides: { prompt: { anthropic: make("anthropic"), deepseek: make("deepseek") } },
      ran,
    };
  }

  const after: WorkflowFile["body"][number] = {
    type: "prompt",
    id: "after",
    name: "after",
    prompt: "after",
  };

  it("resolves the re-run tail from the frozen launch table, over the live file default", async () => {
    const project = open();
    try {
      const launched = {
        ...workflow([person("approve", { publish: { decision: "${output}" } }), after]),
        config: { model: "m" },
      };
      const { overrides, ran } = stubs();
      const first = await project.run(launched, dir, {
        launchWorkerDefaults: { prompt: "deepseek" },
        workerOverrides: overrides,
      });
      expect(first.status).toBe("awaiting");
      const rootRunId = project.archive.listRoots()[0]!.runId;
      const leaf = awaitingLeaf(project, rootRunId);

      // The file handed to Complete carries a *different* live file default; the frozen launch default
      // must still win for the tail, reconstructing the same worker set the launch resolved (ADR 0044).
      const changed = { ...launched, worker_defaults: { prompt: "anthropic" } };
      const done = await project.complete(changed, leaf.runId, { approved: true }, dir, {
        workerOverrides: overrides,
      });
      expect(done.ok).toBe(true);
      if (!done.ok) throw new Error("expected ok");
      expect(done.status).toBe("succeeded");

      expect(rowByNode(project, rootRunId, "after")!.workerName).toBe("deepseek");
      expect(ran).toEqual(["deepseek:after"]);
    } finally {
      project.close();
    }
  });
});

describe("Complete — the frozen launch config (ADR 0046)", () => {
  /** A tail step whose output is the config key it was handed, so a test reads what Complete ran with. */
  const configEcho: WorkflowFile["body"][number] = {
    type: "binary",
    id: "echo",
    name: "echo",
    command: "node",
    args: ["-e", "process.stdout.write(String(process.argv[1]))", "${config.greeting}"],
    publish: { seen: "${output}" },
  };

  function echoingWorkflow(): WorkflowFile {
    return workflow([person("approve"), configEcho], { seen: "${context.seen}" });
  }

  it("recovers the launch config for the tail, which the launch itself never reached", async () => {
    const project = open();
    try {
      const wf = echoingWorkflow();
      const first = await project.run(wf, dir, {
        operatorConfig: { greeting: "launched-with-this" },
      });
      expect(first.status).toBe("awaiting");
      const rootRunId = project.archive.listRoots()[0]!.runId;
      const leaf = awaitingLeaf(project, rootRunId);

      const done = await project.complete(wf, leaf.runId, {}, dir);
      expect(done.ok).toBe(true);
      if (!done.ok) throw new Error("expected ok");
      expect(done.status).toBe("succeeded");
      // The tail ran for the first time here, and read the config the launch recorded — not the file
      // default, and not nothing.
      expect(project.archive.tree(rootRunId)!.output()).toEqual({ seen: "launched-with-this" });
    } finally {
      project.close();
    }
  });

  it("fails on a named key when the frozen secret is not supplied again, and runs when it is", async () => {
    // Two launches, because a Complete consumes its leaf: the first continues without the secret and
    // ends before the tail, the second re-enters it and reaches the tail.
    const project = open();
    try {
      const wf = workflow([person("approve"), configEcho], { seen: "${context.seen}" });
      await project.run(wf, dir, {
        operatorConfig: { greeting: "hi", apiKey: { $secret: "sk-1" } },
      });
      const firstRoot = project.archive.listRoots()[0]!.runId;

      // Nothing supplied this time: the frozen credential is a token, so the continuation ends on a
      // named key rather than replaying a non-credential into the run.
      const refused = await project.complete(wf, awaitingLeaf(project, firstRoot).runId, {}, dir);
      expect(refused.ok).toBe(true);
      if (!refused.ok) throw new Error("expected ok");
      expect(refused.status).toBe("failed");
      expect(refused.error).toContain('launch config secret "apiKey" was not supplied again');

      await project.run(wf, dir, {
        operatorConfig: { greeting: "hi", apiKey: { $secret: "sk-1" } },
      });
      const secondRoot = project.archive.listRoots()[0]!.runId;
      const supplied = await project.complete(
        wf,
        awaitingLeaf(project, secondRoot).runId,
        {},
        dir,
        {
          operatorConfig: { apiKey: "sk-2" },
        },
      );
      expect(supplied.ok).toBe(true);
      if (!supplied.ok) throw new Error("expected ok");
      expect(supplied.status).toBe("succeeded");
      expect(project.archive.tree(secondRoot)!.output()).toEqual({ seen: "hi" });
      // The re-entered plain value was re-marked before use, so the tree's frozen copy holds a token.
      expect(project.archive.launchFacts(secondRoot)?.secretKeys).toEqual(["apiKey"]);
      expect(JSON.stringify(project.archive.launchFacts(secondRoot))).not.toContain("sk-2");
    } finally {
      project.close();
    }
  });
});
