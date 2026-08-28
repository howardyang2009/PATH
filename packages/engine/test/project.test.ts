import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { WorkflowFile } from "@path/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadWorkflowTree } from "../src/load-workflow-tree.js";
import { readNdjsonLog } from "../src/logging/ndjson-backend.js";
import { blobRef, pathDir, rootRunTreeDir } from "../src/persistence/paths.js";
import type { LogBackend } from "../src/logging/log-backend.js";
import { openProject, type Project } from "../src/project.js";
import type { Observation, RunObserver } from "../src/run-observer.js";
import { stampGuids, stampNames } from "./stamp-names.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "path-engine-project-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function open(): Project {
  const opened = openProject(dir);
  if (!opened.success) throw new Error(`${opened.kind}: ${opened.error}`);
  return opened.project;
}

function writeSettings(settings: unknown): void {
  mkdirSync(pathDir(dir), { recursive: true });
  writeFileSync(join(pathDir(dir), "settings.json"), JSON.stringify(settings), "utf8");
}

const oneStep: WorkflowFile = stampNames({
  format: "path/workflow@3",
  id: "wf-id",
  name: "one-step",
  body: [{ type: "binary", id: "only", name: "only", command: "node", args: ["-e", "process.stdout.write('ok')"] }],
});

// A binary step that emits `text` on stdout, or (when `text` is undefined) exits 1 — the two halves
// of a run driven to a stopping point and then resumed past it.
function emit(id: string, text?: string): WorkflowFile["body"][number] {
  const script = text !== undefined ? `process.stdout.write('${text}')` : "process.exit(1)";
  return { type: "binary", id, name: id, command: "node", args: ["-e", script], publish: { [`from_${id}`]: "${output}" } };
}

describe("openProject", () => {
  it("ensures .path/ exists and is self-gitignored, then opens the db", () => {
    const project = open();
    try {
      expect(existsSync(join(pathDir(dir), ".gitignore"))).toBe(true);
      expect(readFileSync(join(pathDir(dir), ".gitignore"), "utf8")).toBe("*\n");
      expect(existsSync(join(pathDir(dir), "path.db"))).toBe(true);
      expect(project.dir).toBe(resolve(dir)); // absolute, never a relative caller path
      expect(project.archive.listRoots()).toEqual([]);
    } finally {
      project.close();
    }
  });

  it("loads engine settings, and reports an absent file as no settings", () => {
    const bare = open();
    expect(bare.settings).toEqual({});
    bare.close();

    writeSettings({ "log.backends": ["db"], "processor.concurrency": 2 });
    const configured = open();
    expect(configured.settings).toEqual({ logBackends: ["db"], processorConcurrency: 2 });
    configured.close();
  });

  // The CLI maps these to different exit codes — an operator's malformed settings file is a usage
  // error (2), an unopenable db is not (1) — so the kind has to survive the return.
  it("distinguishes a settings failure from a db failure by kind", () => {
    writeSettings({ "log.backends": ["not-a-backend"] });
    const failed = openProject(dir);
    expect(failed.success).toBe(false);
    if (failed.success) throw new Error("expected failure");
    expect(failed.kind).toBe("settings");
    expect(failed.error).toMatch(/invalid engine-settings file/);
  });
});

describe("Project.run — settings precedence", () => {
  it("uses the built-in default when nothing is configured", async () => {
    const project = open();
    try {
      await project.run(oneStep, dir);
      const [root] = project.archive.listRoots();
      // Both default backends on: rows in the db log table, and a run.log on disk.
      expect(readNdjsonLog(dir, root!.runId)).not.toHaveLength(0);
    } finally {
      project.close();
    }
  });

  it("lets .path/settings.json override the default", async () => {
    writeSettings({ "log.backends": ["db"] });
    const project = open();
    try {
      await project.run(oneStep, dir);
      const [root] = project.archive.listRoots();
      // ndjson deselected by the settings file, so no run.log was written.
      expect(existsSync(join(rootRunTreeDir(dir, root!.runId), "run.log"))).toBe(false);
    } finally {
      project.close();
    }
  });

  it("lets an explicit override beat the settings file", async () => {
    writeSettings({ "log.backends": ["db"] });
    const project = open();
    try {
      await project.run(oneStep, dir, { logBackends: ["db", "ndjson"] });
      const [root] = project.archive.listRoots();
      expect(readNdjsonLog(dir, root!.runId)).not.toHaveLength(0);
    } finally {
      project.close();
    }
  });

  it("applies the same three levels to the Processor cap", async () => {
    writeSettings({ "processor.concurrency": 2 });
    const project = open();
    try {
      expect(project.settings.processorConcurrency).toBe(2);
    } finally {
      project.close();
    }
  });
});

describe("Project.run — observer assembly", () => {
  it("composes persistence and logging, so one call records rows, blobs and a narrative", async () => {
    const project = open();
    try {
      const result = await project.run(oneStep, dir);
      expect(result.status).toBe("succeeded");

      const [root] = project.archive.listRoots();
      const rows = project.archive.tree(root!.runId)!.runs;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.inputRef !== null)).toBe(true);
      expect(readNdjsonLog(dir, root!.runId).map((e) => e.type)).toContain("step-started");
    } finally {
      project.close();
    }
  });

  // The guarantee the server depends on: its capture observer resolves the 202, and a client may
  // GET the run the instant that lands — so persistence must already have written the row.
  it("runs extraObservers after the built-in pair, not before", async () => {
    const project = open();
    try {
      const rowsWhenSeen: number[] = [];
      const spy: RunObserver = {
        observe(o: Observation) {
          if (o.type !== "run-started") return;
          rowsWhenSeen.push((project.archive.tree(o.rootRunId)?.runs.length ?? 0));
        },
      };

      await project.run(oneStep, dir, { extraObservers: [spy] });

      // By the time the extra observer sees `run-started`, persistence has already inserted the row.
      expect(rowsWhenSeen).toEqual([1]);
    } finally {
      project.close();
    }
  });

  it("delivers to extraBackends alongside the configured ones", async () => {
    const project = open();
    try {
      const seen: string[] = [];
      await project.run(oneStep, dir, {
        logBackends: [], // none of the built-in backends
        extraBackends: [
          {
            open: async () => {},
            write: async (event) => void seen.push(event.type),
            close: async () => {},
          },
        ],
      });
      expect(seen).toContain("step-started");
      expect(seen).toContain("step-finished");
    } finally {
      project.close();
    }
  });

  // The other half of the pair order (execute()'s "Persistence first, deliberately"): a log backend
  // that throws fails the run audit-first, but the persisted observer runs *before* the logging one,
  // so it has already written the root row by the time the throw aborts the rest. The row is what
  // survives a failed audit. Swap the two tiers and the throw lands before persistence — no row.
  it("keeps the run row when a log backend throws — persistence before logging", async () => {
    const project = open();
    try {
      // Throw on the root run's own first log event (its implicit step's start, node_id null), so the
      // failing observation is the very first one — the point where persistence-vs-logging order is
      // observable: persistence-first has inserted the root row; logging-first would not have.
      let thrown = false;
      const failing: LogBackend = {
        async open() {},
        async write(event) {
          if (!thrown && event.type === "step-started" && event.node_id === null) {
            thrown = true;
            throw new Error("backend exploded");
          }
        },
        async close() {},
      };

      const result = await project.run(oneStep, dir, { extraBackends: [failing] });

      // Audit-first: the backend write failure fails the run (mvp spec §8.2).
      expect(result.status).toBe("failed");
      expect(result.error).toMatch(/backend exploded/);

      // But the persisted observer ran first, so the root row is on disk and queryable, ending
      // `failed` — the record that outlives the audit that broke.
      const roots = project.archive.listRoots();
      expect(roots).toHaveLength(1);
      expect(roots[0]!.status).toBe("failed");
    } finally {
      project.close();
    }
  });
});

describe("Project.resume (#173)", () => {
  // v1 stops at `b` (exit 1) after `a` succeeds; v2 is the same tree with `b` fixed to succeed. On
  // resume against v2, `a` reuses its recorded output and only `b` re-runs.
  const v1: WorkflowFile = {
    format: "path/workflow@3",
    id: "wf-id",
    name: "resumable",
    body: [emit("a", "A_OUT"), emit("b")],
    output: { a: "${context.from_a}", b: "${context.from_b}" },
  };
  const v2: WorkflowFile = { ...v1, body: [emit("a", "A_OUT"), emit("b", "B_OUT")] };

  it("returns found:false for an unknown root run id, without throwing", async () => {
    const project = open();
    try {
      const result = await project.resume(v2, "no-such-root", dir);
      expect(result).toEqual({ found: false, error: 'no run found with root run id "no-such-root"' });
    } finally {
      project.close();
    }
  });

  it("treats a non-root (child) run id as not found — only a tree's root resumes", async () => {
    const project = open();
    try {
      const first = await project.run(v1, dir);
      expect(first.status).toBe("failed");
      const rootId = project.archive.listRoots()[0]!.runId;
      // `b`'s own run id is a child of the tree, never a root — resuming from it must not resume the tree.
      const childId = project.archive.tree(rootId)!.runs.find((r) => r.nodeId === "b")!.runId;

      const result = await project.resume(v2, childId, dir);
      expect(result.found).toBe(false);
    } finally {
      project.close();
    }
  });

  it("resumes a stopped run: fresh successor tree, reuses the succeeded node, re-runs the failed one", async () => {
    const project = open();
    try {
      const first = await project.run(v1, dir);
      expect(first.status).toBe("failed");
      const originalRootId = project.archive.listRoots()[0]!.runId;

      const result = await project.resume(v2, originalRootId, dir);
      if (!result.found) throw new Error("expected found:true");

      // Succeeded, and the reused output flows the default-input chain into the workflow output
      // exactly like a freshly produced one would.
      expect(result.status).toBe("succeeded");
      expect(result.output).toEqual({ a: "A_OUT", b: "B_OUT" });

      // The successor is its own root run — a fresh id, distinct from the predecessor, with its own tree.
      expect(result.rootRunId).not.toBe(originalRootId);
      expect(existsSync(rootRunTreeDir(dir, result.rootRunId))).toBe(true);
      const successor = project.archive.tree(result.rootRunId)!;
      expect(successor.root).not.toBeNull();

      // `a` reused (#257): it records a real `succeeded` reuse row — visible in the tree — pointing
      // at the original `a` run (direct-to-source), carrying no spend. `b` re-ran, so its row is an
      // ordinary executed row with no reuse pointer.
      const aRow = successor.runs.find((r) => r.nodeId === "a")!;
      const bRow = successor.runs.find((r) => r.nodeId === "b")!;
      const originalARun = project.archive.tree(originalRootId)!.runs.find((r) => r.nodeId === "a")!.runId;
      expect(aRow.status).toBe("succeeded");
      expect(aRow.reusedFromRunId).toBe(originalARun);
      // The archive resolves the source's tree root too (#257), the other half of the provenance pair,
      // and synthesizes the input/output refs that address the source's blobs — so the reuse row is
      // honest about having I/O rather than shipping null refs a reader could mistake for "none".
      expect(aRow.reusedFromRootRunId).toBe(originalRootId);
      expect(aRow.inputRef).toBe(blobRef(originalRootId, originalARun, "input.json"));
      expect(aRow.outputRef).toBe(blobRef(originalRootId, originalARun, "output.json"));
      expect(aRow.estimatedCostUsd).toBeNull();
      expect(bRow.reusedFromRunId).toBeNull();
      // The reuse row holds no blobs of its own, but reading its I/O through the archive follows the
      // reuse pointer to the source run's tree (#257) — so the viewer's I/O panel shows the reused
      // values rather than "no input object recorded". They match the original `a` run byte-for-byte.
      const original = project.archive.tree(originalRootId)!;
      expect(successor.blob(aRow.runId, "input")).toEqual(original.blob(originalARun, "input"));
      expect(successor.blob(aRow.runId, "output")).toEqual(original.blob(originalARun, "output"));
      expect(successor.blob(aRow.runId, "output")).toEqual("A_OUT");
      // And its narrative still carries the reuse-marker alongside the row (the marker stays the
      // cost/`rm`-guard record); no step-started/step-finished for the reused node.
      const reuseEvents = readNdjsonLog(dir, result.rootRunId).filter((e) => e.type === "reuse-marker");
      expect(reuseEvents).toHaveLength(1);

      // The successor's root row records the lineage; the predecessor's does not.
      expect(successor.root!.resumedFromRootRunId).toBe(originalRootId);
      expect(project.archive.tree(originalRootId)!.root!.resumedFromRootRunId).toBeNull();
    } finally {
      project.close();
    }
  });

  it("keeps reuse direct-to-source across a resume chain: a node reused one hop back stays reused (#257)", async () => {
    // Three-deep chain over [a, b, c]. R1 stops at b (a done); R2 resumes and stops at c (a *reused*
    // from R1, b re-run); R3 resumes R2. In R2, `a` lives only as a reuse row pointing at R1 — it has
    // no output blob of its own. R3 must reuse `a` straight from that pointer (never re-execute it),
    // and its marker must reach past R2 to R1 (direct-to-source, ADR 0001).
    const c1: WorkflowFile = {
      format: "path/workflow@3",
      id: "wf-id",
      name: "chain",
      body: [emit("a", "A_OUT"), emit("b"), emit("c")],
      output: { a: "${context.from_a}", b: "${context.from_b}", c: "${context.from_c}" },
    };
    const c2: WorkflowFile = { ...c1, body: [emit("a", "A_OUT"), emit("b", "B_OUT"), emit("c")] };
    const c3: WorkflowFile = { ...c1, body: [emit("a", "A_OUT"), emit("b", "B_OUT"), emit("c", "C_OUT")] };

    const project = open();
    try {
      const r1 = await project.run(c1, dir);
      expect(r1.status).toBe("failed");
      const root1 = project.archive.listRoots()[0]!.runId;
      const aRunIn1 = project.archive.tree(root1)!.runs.find((r) => r.nodeId === "a")!.runId;

      const r2 = await project.resume(c2, root1, dir);
      if (!r2.found) throw new Error("expected R2 found");
      expect(r2.status).toBe("failed");
      // In R2, `a` is a reuse row pointing straight at R1's run (direct-to-source); `b` re-ran real.
      const aRowIn2 = project.archive.tree(r2.rootRunId)!.runs.find((r) => r.nodeId === "a")!;
      expect(aRowIn2.reusedFromRunId).toBe(aRunIn1);
      const bRunIn2 = project.archive.tree(r2.rootRunId)!.runs.find((r) => r.nodeId === "b")!.runId;

      const r3 = await project.resume(c3, r2.rootRunId, dir);
      if (!r3.found) throw new Error("expected R3 found");
      expect(r3.status).toBe("succeeded");
      expect(r3.output).toEqual({ a: "A_OUT", b: "B_OUT", c: "C_OUT" });

      const runs3 = project.archive.tree(r3.rootRunId)!.runs;
      // `a` and `b` both reuse (reuse rows), only `c` re-ran (an executed row, no reuse pointer).
      const a3 = runs3.find((r) => r.nodeId === "a")!;
      const b3 = runs3.find((r) => r.nodeId === "b")!;
      const c3Row = runs3.find((r) => r.nodeId === "c")!;
      // `a`'s reuse reaches past R2 straight to R1 (direct-to-source); `b`'s to R2's real run.
      expect(a3.reusedFromRunId).toBe(aRunIn1);
      expect(b3.reusedFromRunId).toBe(bRunIn2);
      expect(c3Row.reusedFromRunId).toBeNull();
      // The markers agree with the rows: `a` direct to R1, never to R2.
      const markers3 = readNdjsonLog(dir, r3.rootRunId).filter((e) => e.type === "reuse-marker");
      expect(markers3.find((e) => e.node_id === "a")?.original_run_id).toBe(aRunIn1);
      expect(markers3.find((e) => e.node_id === "b")?.original_run_id).toBe(bRunIn2);
    } finally {
      project.close();
    }
  });

  it("leaves the original tree byte-identical — rows, blobs and run.log all untouched", async () => {
    const project = open();
    try {
      await project.run(v1, dir);
      const originalRootId = project.archive.listRoots()[0]!.runId;

      const rowsBefore = JSON.stringify(project.archive.tree(originalRootId)!.runs);
      const treeBefore = snapshot(rootRunTreeDir(dir, originalRootId));

      const result = await project.resume(v2, originalRootId, dir);
      if (!result.found) throw new Error("expected found:true");

      // On-disk tree — blobs and run.log — is byte-for-byte what it was before the resume.
      expect(snapshot(rootRunTreeDir(dir, originalRootId))).toEqual(treeBefore);
      // ...and the original rows are unchanged too (no status flipped, no ref rewritten).
      expect(JSON.stringify(project.archive.tree(originalRootId)!.runs)).toBe(rowsBefore);
    } finally {
      project.close();
    }
  });
});

describe("Project — the projectDir / workflowDir distinction (#59)", () => {
  it("resolves a nested workflow ref against the workflow's own directory, not the project's", async () => {
    // The shape that broke: the workflow lives in a subdirectory, `.path/` at the project root.
    const sub = join(dir, "flows");
    mkdirSync(sub, { recursive: true });
    writeFileSync(
      join(sub, "child.workflow.json"),
      JSON.stringify(stampGuids({
        format: "path/workflow@3",
        id: "wf-id",
        name: "child",
        body: [{ type: "binary", id: "inner", name: "inner", command: "node", args: ["-e", "process.stdout.write('inner')"] }],
      })),
      "utf8",
    );
    const parent: WorkflowFile = stampGuids({
      format: "path/workflow@3",
      id: "wf-id",
      name: "parent",
      body: [{ type: "workflow", id: "call", name: "call", ref: "./child.workflow.json" }],
    });
    writeFileSync(join(sub, "parent.workflow.json"), JSON.stringify(parent), "utf8");

    const project = open();
    try {
      const loaded = loadWorkflowTree(join(sub, "parent.workflow.json"));
      if (!loaded.success) throw new Error(loaded.errors.join("\n"));

      // `dir` is the project (where `.path/` is); `sub` is the workflow's own directory.
      const result = await project.run(loaded.workflow.rootFile, sub, { files: loaded.workflow.files });

      expect(result.status).toBe("succeeded");
      // ...and the run was still recorded under the project's `.path/`, not the subdirectory's.
      expect(project.archive.listRoots()).toHaveLength(1);
      expect(existsSync(join(sub, ".path"))).toBe(false);
    } finally {
      project.close();
    }
  });
});

// A recursive content snapshot of a directory: relative path → bytes, for an unchanged-check.
function snapshot(root: string): { [rel: string]: string } {
  const out: { [rel: string]: string } = {};
  const walk = (d: string, rel: string): void => {
    for (const entry of readdirSync(d)) {
      const abs = join(d, entry);
      const childRel = rel ? `${rel}/${entry}` : entry;
      if (statSync(abs).isDirectory()) walk(abs, childRel);
      else out[childRel] = readFileSync(abs, "utf8");
    }
  };
  walk(root, "");
  return out;
}
