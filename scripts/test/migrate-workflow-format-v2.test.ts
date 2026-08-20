import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { safeParseWorkflowFile } from "@path/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCodemod } from "./run-codemod.js";

/**
 * The `@1` → `@2` codemod, black-box (#287).
 *
 * The codemod ran once, against this repo's 30 files, and the two behaviours the frozen spec argues
 * for by name went unexercised by anything repeatable: the **refusal** path never fired (no file in
 * the repo collides), and the **rename** path — an unwrapped single-node branch taking its wrapper's
 * `name`, so the `collect` output key survives the unwrap — cannot be re-demonstrated from the repo
 * now that every file is at `@2`. That rename has teeth: `run-parallel.ts` keys collect output by
 * `branch.name`, and `docs/dogfood/format-changelog.js` destructures those keys with `= ""`
 * defaults, so a skipped rename would have produced a silently empty changelog rather than an error.
 *
 * Driven through the process, not the module: the script ends in a bare `main()` at module scope, so
 * importing it would run the codemod against `cwd`. The subprocess also reaches what a unit test of
 * `migrateDocument` cannot — the `process.exitCode = 1` and the stderr report on a refusal.
 */
const scriptsDir = dirname(dirname(fileURLToPath(import.meta.url)));

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "path-codemod-v2-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const uuid = () => randomUUID();

/** A `@1` workflow document. `body` is the one slot `@2` leaves as a node array (§0). */
function legacyFile(body: unknown[]): Record<string, unknown> {
  return { format: "path/workflow@1", id: uuid(), name: "wf", worker: { type: "engine" }, body };
}

const step = (name: string): Record<string, unknown> => ({ type: "binary", id: uuid(), name, command: "echo" });

const exists = { type: "exists", path: "context.x" };

function write(file: string, doc: unknown): string {
  const full = join(dir, file);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, `${JSON.stringify(doc, null, 2)}\n`);
  return full;
}

const read = (file: string): Record<string, unknown> => JSON.parse(readFileSync(file, "utf8"));
const bytes = (file: string): string => readFileSync(file, "utf8");

/** The migrated document must be a *loadable* `@2` file, not merely a reshaped one. */
function expectSchemaValid(file: string): void {
  const result = safeParseWorkflowFile(read(file));
  if (!result.success) throw new Error(`migrated file is not schema-valid @2:\n${result.errors.join("\n")}`);
}

describe("migrate-workflow-format-v2 — parallel branch wrappers", () => {
  it("renames an unwrapped single-node branch to the wrapper's name, keeping the node's own id", () => {
    const inner = step("inner");
    const wrapperId = uuid();
    const file = write(
      "one.workflow.json",
      legacyFile([
        {
          type: "parallel",
          id: uuid(),
          name: "fan",
          join: "collect",
          branches: [{ id: wrapperId, name: "left", body: [inner] }],
        },
      ]),
    );

    const result = runCodemod([file], scriptsDir);
    expect(result.status).toBe(0);
    expectSchemaValid(file);

    const parallel = (read(file).body as Record<string, unknown>[])[0]!;
    const branch = (parallel.branches as Record<string, unknown>[])[0]!;
    // The collect output key was the wrapper's name in `@1`, so the node takes it (§4.3) …
    expect(branch.name).toBe("left");
    // … and keeps its own durable GUID: the wrapper's id is dropped, never inherited (ADR 0006).
    expect(branch.id).toBe(inner.id);
    expect(branch.type).toBe("binary");
    expect(bytes(file)).not.toContain(wrapperId);
  });

  it("turns a multi-node branch wrapper into a sequence carrying the wrapper's id and name", () => {
    const wrapperId = uuid();
    const file = write(
      "many.workflow.json",
      legacyFile([
        {
          type: "parallel",
          id: uuid(),
          name: "fan",
          join: "collect",
          branches: [{ id: wrapperId, name: "left", body: [step("a"), step("b")] }],
        },
      ]),
    );

    expect(runCodemod([file], scriptsDir).status).toBe(0);
    expectSchemaValid(file);

    const parallel = (read(file).body as Record<string, unknown>[])[0]!;
    const branch = (parallel.branches as Record<string, unknown>[])[0]!;
    // The wrapper's shape was already a sequence's, so it is tagged as one rather than re-minted.
    expect(branch.type).toBe("sequence");
    expect(branch.id).toBe(wrapperId);
    expect(branch.name).toBe("left");
    expect((branch.body as Record<string, unknown>[]).map((node) => node.name)).toEqual(["a", "b"]);
  });
});

describe("migrate-workflow-format-v2 — single-node slots", () => {
  it("collapses a single-node arm, else, and while-do body to a bare node", () => {
    const file = write(
      "single.workflow.json",
      legacyFile([
        {
          type: "branch",
          id: uuid(),
          name: "route",
          arms: [{ when: exists, body: [step("arm-a")] }],
          else: [step("fallback")],
        },
        { type: "while-do", id: uuid(), name: "spin", condition: exists, max_iterations: 2, body: [step("inner")] },
      ]),
    );

    expect(runCodemod([file], scriptsDir).status).toBe(0);
    expectSchemaValid(file);

    const [branch, loop] = read(file).body as Record<string, unknown>[];
    const arm = (branch!.arms as Record<string, unknown>[])[0]!;
    expect(arm.body).toBeUndefined();
    expect((arm.node as Record<string, unknown>).name).toBe("arm-a");
    expect((branch!.else as Record<string, unknown>).name).toBe("fallback");
    // The loop body moves `body` → `node`, and `body` is deleted rather than left beside it.
    expect(loop!.body).toBeUndefined();
    expect((loop!.node as Record<string, unknown>).name).toBe("inner");
  });

  it("mints a sequence for a multi-node arm, else, and while-do body", () => {
    const file = write(
      "minted.workflow.json",
      legacyFile([
        {
          type: "branch",
          id: uuid(),
          name: "route",
          arms: [{ when: exists, body: [step("a1"), step("a2")] }],
          else: [step("e1"), step("e2")],
        },
        {
          type: "while-do",
          id: uuid(),
          name: "spin",
          condition: exists,
          max_iterations: 2,
          body: [step("l1"), step("l2")],
        },
      ]),
    );

    expect(runCodemod([file], scriptsDir).status).toBe(0);
    expectSchemaValid(file);

    const [branch, loop] = read(file).body as Record<string, unknown>[];
    const armNode = (branch!.arms as Record<string, unknown>[])[0]!.node as Record<string, unknown>;
    expect(armNode.type).toBe("sequence");
    // The minted name is derived from the owning node, so it reads as that slot's sequence.
    expect(armNode.name).toBe("route-arm");
    expect((armNode.body as Record<string, unknown>[]).map((node) => node.name)).toEqual(["a1", "a2"]);

    const elseNode = branch!.else as Record<string, unknown>;
    expect(elseNode.type).toBe("sequence");
    expect(elseNode.name).toBe("route-else");

    const loopNode = loop!.node as Record<string, unknown>;
    expect(loopNode.type).toBe("sequence");
    expect(loopNode.name).toBe("spin-body");
    expect((loopNode.body as Record<string, unknown>[]).map((node) => node.name)).toEqual(["l1", "l2"]);
  });

  it("disambiguates a minted name that is already taken with a -2 suffix", () => {
    const file = write(
      "clash.workflow.json",
      legacyFile([
        // Occupies the name the minted sequence below would otherwise take.
        step("route-arm"),
        { type: "branch", id: uuid(), name: "route", arms: [{ when: exists, body: [step("a1"), step("a2")] }] },
      ]),
    );

    expect(runCodemod([file], scriptsDir).status).toBe(0);
    expectSchemaValid(file);

    const branch = (read(file).body as Record<string, unknown>[])[1]!;
    const armNode = (branch.arms as Record<string, unknown>[])[0]!.node as Record<string, unknown>;
    expect(armNode.name).toBe("route-arm-2");
  });

  it("leaves the file's top-level body an array (§0 — the one slot it must not touch)", () => {
    const file = write("top.workflow.json", legacyFile([step("a"), step("b")]));

    expect(runCodemod([file], scriptsDir).status).toBe(0);
    expectSchemaValid(file);

    const body = read(file).body;
    expect(Array.isArray(body)).toBe(true);
    expect((body as Record<string, unknown>[]).map((node) => node.name)).toEqual(["a", "b"]);
  });
});

describe("migrate-workflow-format-v2 — refuses rather than inventing (§11)", () => {
  it("refuses a file whose branch unwrap would rename a node onto an existing name", () => {
    const file = write(
      "collide.workflow.json",
      legacyFile([
        step("dup"),
        {
          type: "parallel",
          id: uuid(),
          name: "fan",
          join: "collect",
          branches: [{ id: uuid(), name: "dup", body: [step("inner")] }],
        },
      ]),
    );
    const before = bytes(file);

    const result = runCodemod([file], scriptsDir);

    expect(result.status).toBe(1);
    expect(bytes(file)).toBe(before); // byte-unchanged: a refusal writes nothing
    expect(result.stderr).toContain("refused");
    expect(result.stderr).toContain(file);
    expect(result.stderr).toContain("dup");
  });

  it("refuses an empty container slot rather than writing a schema-invalid file", () => {
    // `@2`'s `sequence.body` is min 1, so an empty slot has no `@2` spelling. Unreachable from a
    // valid `@1` file (its slots were min 1 too) but reachable by hand, and the codemod validates
    // nothing on the way in — so it refuses rather than emitting `{ type: "sequence", body: [] }`.
    const file = write(
      "empty.workflow.json",
      legacyFile([{ type: "branch", id: uuid(), name: "route", arms: [{ when: exists, body: [] }] }]),
    );
    const before = bytes(file);

    const result = runCodemod([file], scriptsDir);

    expect(result.status).toBe(1);
    expect(bytes(file)).toBe(before);
    expect(result.stderr).toContain("refused");
    expect(result.stderr).toContain("route");
  });

  it("refuses an empty parallel branch wrapper for the same reason", () => {
    const file = write(
      "empty-branch.workflow.json",
      legacyFile([
        { type: "parallel", id: uuid(), name: "fan", join: "collect", branches: [{ id: uuid(), name: "left", body: [] }] },
      ]),
    );
    const before = bytes(file);

    const result = runCodemod([file], scriptsDir);

    expect(result.status).toBe(1);
    expect(bytes(file)).toBe(before);
    expect(result.stderr).toContain("left");
  });

  it("reports the refusal without abandoning the other files on the command line", () => {
    const good = write("good.workflow.json", legacyFile([step("a")]));
    const bad = write(
      "bad.workflow.json",
      legacyFile([
        step("dup"),
        {
          type: "parallel",
          id: uuid(),
          name: "fan",
          join: "collect",
          branches: [{ id: uuid(), name: "dup", body: [step("inner")] }],
        },
      ]),
    );

    const result = runCodemod([bad, good], scriptsDir);

    expect(result.status).toBe(1);
    expect(read(good).format).toBe("path/workflow@2");
    expect(read(bad).format).toBe("path/workflow@1");
  });
});

describe("migrate-workflow-format-v2 — idempotency", () => {
  it("leaves a file already at @2 byte-identical", () => {
    const file = write("already.workflow.json", {
      format: "path/workflow@2",
      id: uuid(),
      name: "wf",
      worker: { type: "engine" },
      body: [step("a")],
    });
    const before = bytes(file);

    const result = runCodemod([file], scriptsDir);

    expect(result.status).toBe(0);
    expect(bytes(file)).toBe(before);
  });

  it("skips a @0 file rather than half-migrating it", () => {
    const file = write("old.workflow.json", {
      format: "path/workflow@0",
      id: "wf",
      name: "wf",
      worker: { type: "engine" },
      body: [{ type: "binary", id: "a", command: "echo" }],
    });
    const before = bytes(file);

    const result = runCodemod([file], scriptsDir);

    expect(result.status).toBe(0);
    expect(bytes(file)).toBe(before);
  });

  it("is idempotent across a second run over the same file", () => {
    const file = write(
      "twice.workflow.json",
      legacyFile([
        {
          type: "parallel",
          id: uuid(),
          name: "fan",
          join: "collect",
          branches: [{ id: uuid(), name: "left", body: [step("a"), step("b")] }],
        },
      ]),
    );

    expect(runCodemod([file], scriptsDir).status).toBe(0);
    const afterFirst = bytes(file);
    expect(runCodemod([file], scriptsDir).status).toBe(0);
    expect(bytes(file)).toBe(afterFirst);
  });
});

describe("migrate-workflow-format-v2 — discovery", () => {
  it("with no arguments migrates every *.workflow.json under cwd, skipping node_modules and dot-dirs", () => {
    const nested = write("docs/nested/deep.workflow.json", legacyFile([step("a")]));
    const top = write("top.workflow.json", legacyFile([step("b")]));
    // `.path/` holds run JSON, and a dependency's fixtures are not this repo's to rewrite.
    const inDotDir = write(".path/runs/run.workflow.json", legacyFile([step("c")]));
    const inModules = write("node_modules/dep/fixture.workflow.json", legacyFile([step("d")]));
    const notAWorkflow = write("plain.json", legacyFile([step("e")]));

    const result = runCodemod([], dir);

    expect(result.status).toBe(0);
    expect(read(nested).format).toBe("path/workflow@2");
    expect(read(top).format).toBe("path/workflow@2");
    expect(read(inDotDir).format).toBe("path/workflow@1");
    expect(read(inModules).format).toBe("path/workflow@1");
    expect(read(notAWorkflow).format).toBe("path/workflow@1");
  });
});
