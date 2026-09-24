import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadStepPluginRegistry, openProject, type Project } from "@path/engine";
import { instantiate, validateOutputSchema, type JsonValue, type WorkflowFile, type WorkflowNode } from "@path/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SHIPPED_TEMPLATE_DIR, discoverTemplates, type TemplateEntry } from "../src/template-store.js";

/**
 * The shipped `person-switch` Step-Template (#581, ADR 0052): a `person-activity` ask followed by a
 * `branch` on the chosen label, wrapped in one `sequence`. It is authoring sugar over two existing
 * primitives — no engine type — so the proof is the demo: instantiate it, run it, reach Awaiting at the
 * ask, Complete with a label, and see only the matching arm run.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "path-person-switch-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function personSwitch(): Promise<TemplateEntry> {
  const registry = await loadStepPluginRegistry();
  const entry = discoverTemplates(dir, DEFAULT_SHIPPED_TEMPLATE_DIR, registry).entries.find(
    (e) => e.kind === "step" && e.name === "person-switch",
  );
  if (!entry) throw new Error("person-switch step-template is not shipped");
  return entry;
}

function open(): Project {
  const opened = openProject(dir);
  if (!opened.success) throw new Error(`${opened.kind}: ${opened.error}`);
  return opened.project;
}

function allNodes(nodes: WorkflowNode[]): WorkflowNode[] {
  const out: WorkflowNode[] = [];
  const visit = (node: WorkflowNode) => {
    out.push(node);
    const loose = node as unknown as { body?: WorkflowNode[]; arms?: { node: WorkflowNode }[]; else?: WorkflowNode };
    loose.body?.forEach(visit);
    loose.arms?.forEach((arm) => visit(arm.node));
    if (loose.else) visit(loose.else);
  };
  nodes.forEach(visit);
  return out;
}

function byName(nodes: WorkflowNode[], name: string): WorkflowNode {
  const node = allNodes(nodes).find((n) => n.name === name);
  if (!node) throw new Error(`no node named ${name}`);
  return node;
}

describe("person-switch step-template (ADR 0052)", () => {
  it("is a shipped, read-only, valid step-template whose body is one sequence of [person-activity, branch]", async () => {
    const entry = await personSwitch();
    expect({ origin: entry.origin, readOnly: entry.readOnly, valid: entry.valid, error: entry.error }).toEqual({
      origin: "shipped",
      readOnly: true,
      valid: true,
      error: null,
    });

    const body = entry.body as WorkflowNode[];
    expect(body).toHaveLength(1);
    const [sequence] = body as unknown as [{ type: string; body: WorkflowNode[] }];
    expect(sequence.type).toBe("sequence");
    expect(sequence.body.map((n) => n.type)).toEqual(["person-activity", "branch"]);

    // The ask's outputSchema is a string enum of exactly the branch's arm labels, one arm per label.
    const ask = sequence.body[0] as unknown as { outputSchema: { properties: { choice: { enum: string[] } } } };
    const branch = sequence.body[1] as unknown as { arms: { when: { type: string; path: string; value: string } }[]; else?: unknown };
    const labels = ask.outputSchema.properties.choice.enum;
    expect(branch.arms.map((arm) => arm.when)).toEqual(labels.map((value) => ({ type: "equals", path: "output.choice", value })));
    expect(branch.else).toBeUndefined();

    // The schema accepts each label and refuses anything else.
    for (const label of labels) expect(validateOutputSchema(ask.outputSchema as unknown as JsonValue, { choice: label }).ok).toBe(true);
    expect(validateOutputSchema(ask.outputSchema as unknown as JsonValue, { choice: "nope" }).ok).toBe(false);
    expect(validateOutputSchema(ask.outputSchema as unknown as JsonValue, {}).ok).toBe(false);
  });

  it("no engine person-switch type exists", async () => {
    const registry = await loadStepPluginRegistry();
    expect(Object.keys(registry)).not.toContain("person-switch");
  });

  it("instantiates with fresh ids, runs to Awaiting at the ask, and Complete runs only the chosen arm", async () => {
    const entry = await personSwitch();
    const source = entry.body as WorkflowNode[];
    const body = instantiate(source);

    const sourceIds = new Set(allNodes(source).map((n) => n.id));
    const freshIds = allNodes(body).map((n) => n.id);
    expect(freshIds).toHaveLength(sourceIds.size);
    for (const id of freshIds) expect(sourceIds.has(id)).toBe(false);

    const wf = { format: "path/workflow@4", id: crypto.randomUUID(), name: "person-switch-demo", body } as WorkflowFile;
    const project = open();
    try {
      expect((await project.run(wf, dir)).status).toBe("awaiting");
      const rootRunId = project.archive.listRoots()[0]!.runId;
      const ask = byName(body, "choose");
      const leaf = project.archive.tree(rootRunId)!.runs.find((r) => r.status === "awaiting")!;
      expect(leaf.nodeId).toBe(ask.id);

      const done = await project.complete(wf, leaf.runId, { choice: "option-b" }, dir);
      expect(done.ok && done.status).toBe("succeeded");

      const runs = project.archive.tree(rootRunId)!.runs;
      expect(runs.find((r) => r.nodeId === byName(body, "option-b").id)?.status).toBe("succeeded");
      expect(runs.find((r) => r.nodeId === byName(body, "option-a").id)).toBeUndefined();
    } finally {
      project.close();
    }
  });
});
