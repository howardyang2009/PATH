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
 * Resume across goto passes (docs/spec/goto.md §8.1, ADR 0054 §5–6, ADR 0060 §3; §11 rows G-E-14 to
 * G-E-18), driven through `Project.resume` over a real store: a predecessor run is recorded, then a
 * successor resumes it, and every assertion reads the successor's own tree, events and executions.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "path-engine-goto-resume-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function open(): Project {
  const opened = openProject(dir);
  if (!opened.success) throw new Error(`${opened.kind}: ${opened.error}`);
  return opened.project;
}

/**
 * A scripted `prompt` worker. Each prompt text is a step; its answers are taken in order from
 * `answers[prompt]`, falling back to `<prompt>-<visit>` (the visit counted per prompt for this worker).
 * A prompt in `failing` fails. `ran` records every execution, so a reused node is one that is absent.
 */
function scripted(ran: string[], opts: { failing?: string[]; answers?: { [prompt: string]: string[] } } = {}) {
  const visits = new Map<string, number>();
  const worker: WorkerDescriptor = {
    meters: false,
    needsProcessorSlot: true,
    async run(request) {
      const prompt = String((request.fields as { prompt: string }).prompt);
      ran.push(prompt);
      const visit = (visits.get(prompt) ?? 0) + 1;
      visits.set(prompt, visit);
      if (opts.failing?.includes(prompt)) return { status: "failed", error: `${prompt} failed` };
      return { status: "succeeded", output: opts.answers?.[prompt]?.[visit - 1] ?? `${prompt}-${visit}` };
    },
  };
  return { prompt: { anthropic: worker } };
}

function step(name: string, extra: { [key: string]: unknown } = {}) {
  return { type: "prompt", id: name, prompt: name, ...extra };
}

function guarded(id: string, arms: { values: string[]; goto: string; target: string; maxJumps?: number }[], elseStep: string) {
  return {
    type: "branch",
    id,
    arms: arms.map((arm) => ({
      when: { type: "one-of", path: "context.last", values: arm.values },
      node: { type: "goto", id: arm.goto, target: arm.target, max_jumps: arm.maxJumps ?? 3 },
    })),
    else: step(elseStep),
  };
}

function file(body: unknown[]): WorkflowFile {
  return stampNames({ format: "path/workflow@5", id: "wf-id", name: "jumps", config: { model: "m" }, body } as unknown as WorkflowFile);
}

/** The observations a successor emits, captured by an observer appended after the built-in pair. */
function capture(): { observer: RunObserver; all: Observation[] } {
  const all: Observation[] = [];
  return { observer: { observe: async (o: Observation) => void all.push(o) } as unknown as RunObserver, all };
}

/** A tree's pass rows under its root, in ordinal order, and each pass's direct children. */
function passesOf(runs: RunRecord[]) {
  const root = runs.find((r) => r.parentRunId === null)!;
  const passes = runs.filter((r) => r.parentRunId === root.runId && isPassRun(r)).sort((a, b) => a.pass! - b.pass!);
  return passes.map((p) => ({
    pass: p.pass,
    opener: p.nodeName,
    status: p.status,
    runId: p.runId,
    children: runs.filter((r) => r.parentRunId === p.runId),
  }));
}

/** Each child as `name` (executed) or `name*` (a reuse row). */
function shape(children: RunRecord[]): string[] {
  return children.map((r) => `${r.nodeName}${r.reusedFromRunId !== null ? "*" : ""}`);
}

async function originalRoot(project: Project): Promise<string> {
  return project.archive.listRoots().at(-1)!.runId;
}

describe("goto — Resume pairs passes (spec §8.1)", () => {
  // `[a, b, guard]`: the guard jumps back to `b` while `b`'s output is `b-1` or `b-2`, so pass 1 is
  // `a, b`, pass 2 is `b`, pass 3 is `b, done`.
  const loop = () =>
    file([step("a"), step("b", { publish: { last: "${output}" } }), guarded("guard", [{ values: ["b-1", "b-2"], goto: "check", target: "b" }], "done")]);

  it("G-E-14: a run failed in pass 3 pairs passes 1–2 and reuses them; pass 3 reuses its succeeded nodes and re-runs from the failure", async () => {
    const project = open();
    try {
      const first = await project.run(loop(), dir, { workerOverrides: scripted([], { failing: ["done"] }) });
      expect(first.status).toBe("failed");
      const rootId = await originalRoot(project);
      expect(passesOf(project.archive.tree(rootId)!.runs).map((p) => [p.pass, p.status])).toEqual([
        [1, "succeeded"],
        [2, "succeeded"],
        [3, "failed"],
      ]);

      const ran: string[] = [];
      const result = await project.resume(loop(), rootId, dir, { workerOverrides: scripted(ran) });
      if (!result.found) throw new Error(`expected found:true, got ${JSON.stringify(result)}`);
      expect(result.status).toBe("succeeded");
      // Only the failure re-ran: every `a` / `b` visit reused its paired pass's row.
      expect(ran).toEqual(["done"]);

      const passes = passesOf(project.archive.tree(result.rootRunId)!.runs);
      expect(passes.map((p) => [p.pass, p.opener, p.status])).toEqual([
        [1, null, "succeeded"],
        [2, "check", "succeeded"],
        [3, "check", "succeeded"],
      ]);
      expect(passes.map((p) => shape(p.children))).toEqual([["a*", "b*"], ["b*"], ["b*", "done"]]);
    } finally {
      project.close();
    }
  });

  it("G-E-15: after an edit makes a different goto open pass 2, pass 2 and every later pass run fresh", async () => {
    const project = open();
    try {
      await project.run(loop(), dir, { workerOverrides: scripted([], { failing: ["done"] }) });
      const rootId = await originalRoot(project);

      // The edit: `b-1` now jumps through a new goto `other`, so pass 2's opener no longer matches. Pass
      // 3 is opened by `check` again, the same goto that opened the predecessor's pass 3, and still runs
      // fresh: the walk left the record at pass 2.
      const edited = file([
        step("a"),
        step("b", { publish: { last: "${output}" } }),
        guarded(
          "guard",
          [
            { values: ["b-1"], goto: "other", target: "b" },
            { values: ["b-2"], goto: "check", target: "b" },
          ],
          "done",
        ),
      ]);
      const ran: string[] = [];
      const result = await project.resume(edited, rootId, dir, { workerOverrides: scripted(ran, { answers: { b: ["b-2", "b-3"] } }) });
      if (!result.found) throw new Error("expected found:true");
      expect(result.status).toBe("succeeded");
      expect(ran).toEqual(["b", "b", "done"]);

      const passes = passesOf(project.archive.tree(result.rootRunId)!.runs);
      expect(passes.map((p) => [p.pass, p.opener])).toEqual([
        [1, null],
        [2, "other"],
        [3, "check"],
      ]);
      expect(passes.map((p) => shape(p.children))).toEqual([["a*", "b*"], ["b"], ["b", "done"]]);
    } finally {
      project.close();
    }
  });

  it("G-E-16: Resume-from-K with K in pass 2 reuses pass 1 and pass 2 before K, re-runs K on, and runs later passes fresh", async () => {
    // `[a, b, c, guard]`: the guard jumps back to `b` while `c`'s output is `c-1` or `c-2`, so every
    // pass holds `b, c`; pass 3 ends in `done`. The original run succeeds whole.
    const kLoop = () =>
      file([
        step("a"),
        step("b"),
        step("c", { publish: { last: "${output}" } }),
        guarded("guard", [{ values: ["c-1", "c-2"], goto: "check", target: "b" }], "done"),
      ]);
    const project = open();
    try {
      expect((await project.run(kLoop(), dir, { workerOverrides: scripted([]) })).status).toBe("succeeded");
      const rootId = await originalRoot(project);
      const original = passesOf(project.archive.tree(rootId)!.runs);
      const kRunId = original[1]!.children.find((r) => r.nodeName === "c")!.runId;

      const ran: string[] = [];
      const result = await project.resume(kLoop(), rootId, dir, {
        rerunFromRunId: kRunId,
        workerOverrides: scripted(ran, { answers: { c: ["c-2", "c-3"] } }),
      });
      if (!result.found) throw new Error(`expected found:true, got ${JSON.stringify(result)}`);
      expect(result.status).toBe("succeeded");
      // Pass 2's `c` re-runs; pass 3 is fresh whole, though its opener matches the predecessor's.
      expect(ran).toEqual(["c", "b", "c", "done"]);

      const successor = project.archive.tree(result.rootRunId)!;
      const passes = passesOf(successor.runs);
      expect(passes.map((p) => [p.pass, p.opener])).toEqual([
        [1, null],
        [2, "check"],
        [3, "check"],
      ]);
      expect(passes.map((p) => shape(p.children))).toEqual([["a*", "b*", "c*"], ["b*", "c"], ["b", "c", "done"]]);
      // The boundary's level names the pass K sits in.
      expect(successor.root!.rerunFromNodePath).toEqual([{ nodeId: "c", nodeName: "c", pass: 2 }]);
    } finally {
      project.close();
    }
  });

  it("G-E-17: Resume-from-K into pass 1 of a loop that publishes in later passes: K sees its original context", async () => {
    // `x` is published by `a` before K and again by `late` after it, in every pass. K in pass 1 saw `a`'s
    // value; the predecessor's final blackboard holds `late`'s last one, which must not leak into K.
    const publishing = () =>
      file([
        step("a", { publish: { x: "${output}" } }),
        step("k", { input: { saw: "${context.x}" } }),
        step("late", { publish: { x: "${output}", last: "${output}" } }),
        guarded("guard", [{ values: ["late-1"], goto: "again", target: "k" }], "done"),
      ]);
    const project = open();
    try {
      await project.run(publishing(), dir, { workerOverrides: scripted([]) });
      const rootId = await originalRoot(project);
      const pass1 = passesOf(project.archive.tree(rootId)!.runs)[0]!;
      const kRunId = pass1.children.find((r) => r.nodeName === "k")!.runId;

      const inputs: unknown[] = [];
      const worker = scripted([]).prompt.anthropic;
      const spying: WorkerDescriptor = {
        ...worker,
        run: async (request) => {
          if ((request.fields as { prompt: string }).prompt === "k") inputs.push(request.input);
          return worker.run(request);
        },
      };
      const result = await project.resume(publishing(), rootId, dir, { rerunFromRunId: kRunId, workerOverrides: { prompt: { anthropic: spying } } });
      if (!result.found) throw new Error(`expected found:true, got ${JSON.stringify(result)}`);
      expect(result.status).toBe("succeeded");
      expect(inputs[0]).toEqual({ saw: "a-1" });
    } finally {
      project.close();
    }
  });

  it("Resume-from-K after a goto was added to a goto-free file runs every pass fresh: the record has no pass to pair", async () => {
    const project = open();
    try {
      await project.run(file([step("a"), step("b"), step("c")]), dir, { workerOverrides: scripted([], { failing: ["c"] }) });
      const rootId = await originalRoot(project);
      const kRunId = project.archive.tree(rootId)!.runs.find((r) => r.nodeName === "b")!.runId;

      const ran: string[] = [];
      const edited = file([step("a"), step("b"), step("c", { publish: { last: "${output}" } }), guarded("guard", [{ values: ["never"], goto: "check", target: "a" }], "done")]);
      const result = await project.resume(edited, rootId, dir, { rerunFromRunId: kRunId, workerOverrides: scripted(ran) });
      if (!result.found) throw new Error(`expected found:true, got ${JSON.stringify(result)}`);
      expect(result.status).toBe("succeeded");
      expect(ran).toEqual(["a", "b", "c", "done"]);
    } finally {
      project.close();
    }
  });

  it("the eligibility listing offers first-level nodes per pass, never a pass row or an inner node of a first-level block", async () => {
    const project = open();
    try {
      await project.run(loop(), dir, { workerOverrides: scripted([]) });
      const rootId = await originalRoot(project);
      const listing = project.listEligible(loop(), rootId, dir);
      if (!listing.found) throw new Error(listing.error);

      const passOf = new Map(project.archive.tree(rootId)!.runs.filter(isPassRun).map((p) => [p.runId, p.pass]));
      const runs = new Map(project.archive.tree(rootId)!.runs.map((r) => [r.runId, r]));
      const rows = listing.rows.map((row) => {
        const record = runs.get(row.runId)!;
        const where = isPassRun(record) ? `pass ${record.pass}` : `${row.nodeName} in pass ${passOf.get(record.parentRunId!) ?? "-"}`;
        return [where, row.verdict.eligible ? "yes" : row.verdict.reason];
      });
      expect(rows).toEqual([
        ["null in pass -", "root-run"],
        ["pass 1", "pass-run"],
        ["a in pass 1", "yes"],
        ["b in pass 1", "yes"],
        ["pass 2", "pass-run"],
        ["b in pass 2", "yes"],
        ["pass 3", "pass-run"],
        ["b in pass 3", "yes"],
        // `done` is the guard branch's else arm: inside a first-level block.
        ["done in pass 3", "in-body"],
      ]);

      // `--from` a pass row is refused with the same verdict, and no successor starts.
      const pass2 = [...passOf].find(([, pass]) => pass === 2)![0];
      const refused = await project.resume(loop(), rootId, dir, { rerunFromRunId: pass2, workerOverrides: scripted([]) });
      expect(refused).toMatchObject({ found: false, refusal: { status: 400, reason: "pass-run" } });
    } finally {
      project.close();
    }
  });

  it("G-E-18: the successor's log has its own pass-started and goto-taken for every jump, into paired passes too", async () => {
    const project = open();
    try {
      await project.run(loop(), dir, { workerOverrides: scripted([], { failing: ["done"] }) });
      const rootId = await originalRoot(project);

      const { observer, all } = capture();
      const result = await project.resume(loop(), rootId, dir, { workerOverrides: scripted([]), extraObservers: [observer] });
      if (!result.found) throw new Error("expected found:true");

      const gotoEvents = all.flatMap((o) => {
        if (o.type === "pass-started") return [`${o.runId === result.rootRunId ? "own" : "other"} pass-started ${o.pass}`];
        if (o.type === "goto-taken") return [`${o.runId === result.rootRunId ? "own" : "other"} goto-taken ${o.jump}/${o.maxJumps} pass ${o.pass}`];
        return [];
      });
      expect(gotoEvents).toEqual([
        "own pass-started 1",
        "own goto-taken 1/3 pass 2",
        "own pass-started 2",
        "own goto-taken 2/3 pass 3",
        "own pass-started 3",
      ]);
    } finally {
      project.close();
    }
  });
});
