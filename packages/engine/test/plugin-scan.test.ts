import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeWorkflowFileSchema } from "@path/schema";

import { entryImportUrl, scanStepPlugins, STEP_PLUGINS_DIR } from "../src/plugin/scan.js";

// The engine-side plugin discovery scanner (#335, ADR 0019 sub-decisions 7–17). These tests drive it
// against fixture directories built at run time under `test/`, so a fixture plugin's `index.ts` resolves
// the `@path/engine/plugin` subpath the same way a real plugin folder would. The scanner is additive and
// unwired — nothing on the load path calls it yet — so its whole contract is proven here.

// A well-formed entry module. The scanner only shallow-checks the four seam keys, so a plain object is a
// valid plugin for the scan; the deeper zod invariants belong to the schema factory.
function validEntry(marker = "default"): string {
  return `export const stepPlugin = { fields: {}, config: {}, workers: { run: { meters: false, needsProcessorSlot: false, run: async () => ({ status: "succeeded", output: null }) } }, defaultWorker: "run", marker: ${JSON.stringify(marker)} };\n`;
}

// An entry module with a real zod `fields` fragment, imported from the public subpath exactly as a
// third-party plugin does. `fieldKey` names the single field, so a colliding `publish` can be produced.
function zodEntry(fieldKey: string): string {
  return (
    `import { z } from "@path/engine/plugin";\n` +
    `export const stepPlugin = { fields: { ${fieldKey}: z.string() }, config: {}, ` +
    `workers: { call: { meters: false, needsProcessorSlot: false, run: async () => ({ status: "succeeded", output: null }) } }, ` +
    `defaultWorker: "call" };\n`
  );
}

// The test directory itself — fixtures live beneath it so bare specifiers walk up to the repo's
// `node_modules`, exactly as a real `packages/engine/step-plugins/<name>/` folder does.
const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));

let root: string;

beforeEach(async () => {
  // No dot prefix: the runner's dev server refuses to serve modules under a dot-directory, so a
  // fixture plugin's `index.ts` would fail to import for reasons unrelated to the scanner.
  root = await mkdtemp(join(TEST_DIR, "scan-fixtures-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// Write one plugin folder `<root>/<name>/index.ts` with the given entry source. Pass `entry: null` for a
// folder with no entry file at all.
async function writePlugin(name: string, entry: string | null): Promise<string> {
  const folder = join(root, name);
  await mkdir(folder, { recursive: true });
  if (entry !== null) await writeFile(join(folder, "index.ts"), entry);
  return folder;
}

describe("scanStepPlugins — the happy path", () => {
  it("returns a registry keyed by folder name from well-formed folders", async () => {
    await writePlugin("alpha", validEntry("a"));
    await writePlugin("beta", validEntry("b"));

    const registry = await scanStepPlugins(root);

    expect(Object.keys(registry)).toEqual(["alpha", "beta"]);
    expect(registry.alpha).toMatchObject({ defaultWorker: "run" });
    expect(registry.alpha!.fields).toEqual({});
    expect(typeof registry.beta!.workers.run!.run).toBe("function");
  });

  it("keys the registry in lexicographic folder order regardless of readdir order", async () => {
    await writePlugin("zebra", validEntry());
    await writePlugin("mango", validEntry());
    await writePlugin("apple", validEntry());

    const registry = await scanStepPlugins(root);

    expect(Object.keys(registry)).toEqual(["apple", "mango", "zebra"]);
  });
});

describe("scanStepPlugins — the scan rules", () => {
  it("skips non-directory entries and dot-prefixed directories", async () => {
    await writePlugin("alpha", validEntry());
    await writeFile(join(root, "README.md"), "not a plugin\n");
    // A dot-prefixed directory that would throw *if* it were scanned — proof it is skipped, not loaded.
    await writePlugin(".hidden", "throw new Error('should never import');\n");

    const registry = await scanStepPlugins(root);

    expect(Object.keys(registry)).toEqual(["alpha"]);
  });

  it("rejects a folder name that breaks the `^[a-z][a-z0-9-]*$` pattern", async () => {
    await writePlugin("Bad-Name", validEntry());

    await expect(scanStepPlugins(root)).rejects.toThrow(/folder name must match/);
  });

  it("reports the lexicographically first broken folder, so the error is stable across machines", async () => {
    await writePlugin("a-broken", "throw new Error('boom-a');\n");
    await writePlugin("b-broken", "throw new Error('boom-b');\n");

    await expect(scanStepPlugins(root)).rejects.toThrow(/a-broken/);
    await expect(scanStepPlugins(root)).rejects.not.toThrow(/b-broken/);
  });
});

describe("scanStepPlugins — reserved names, checked before import", () => {
  it("rejects a reserved-name folder before importing its index.ts", async () => {
    // The `index.ts` also throws; the verdict must be the reserved name (the actionable truth), not the
    // incidental import failure (ADR 0019 sub-14).
    await writePlugin("while-do", "throw new Error('index also throws');\n");

    const scan = scanStepPlugins(root);
    await expect(scan).rejects.toThrow(/reserved control construct/);
    await expect(scan).rejects.not.toThrow(/threw at import/);
  });

  it.each(["workflow", "parallel", "branch", "while-do", "sequence", "checkpoint"])(
    "rejects the reserved name %s",
    async (name) => {
      await writePlugin(name, validEntry());
      await expect(scanStepPlugins(root)).rejects.toThrow(/reserved control construct/);
    },
  );

  it("does not reserve `binary` or `prompt` — they are ordinary folders now", async () => {
    await writePlugin("binary", validEntry());
    await writePlugin("prompt", validEntry());

    const registry = await scanStepPlugins(root);

    expect(Object.keys(registry)).toEqual(["binary", "prompt"]);
  });
});

describe("scanStepPlugins — broken plugins are hard failures", () => {
  it("fails a candidate directory with no index.ts, naming the folder", async () => {
    await writePlugin("noentry", null);

    await expect(scanStepPlugins(root)).rejects.toThrow(/step plugin "noentry": no index\.ts/);
  });

  it("fails an index.ts that throws at import, naming the folder and the reason", async () => {
    await writePlugin("kaboom", "throw new Error('deliberate import failure');\n");

    await expect(scanStepPlugins(root)).rejects.toThrow(
      /step plugin "kaboom": index\.ts threw at import — deliberate import failure/,
    );
  });

  it("fails a missing `stepPlugin` export", async () => {
    await writePlugin("noexport", "export const somethingElse = 1;\n");

    await expect(scanStepPlugins(root)).rejects.toThrow(/no named `stepPlugin` export/);
  });

  it("fails a malformed `stepPlugin` export", async () => {
    // Shape missing `defaultWorker` — a plain value where the seam wants a name.
    await writePlugin("malformed", "export const stepPlugin = { fields: {}, config: {}, workers: {} };\n");

    await expect(scanStepPlugins(root)).rejects.toThrow(/`stepPlugin` export is malformed/);
  });

  it("rejects a non-object `stepPlugin` export", async () => {
    await writePlugin("scalar", "export const stepPlugin = 42;\n");

    await expect(scanStepPlugins(root)).rejects.toThrow(/`stepPlugin` export is malformed/);
  });
});

describe("entryImportUrl — the freshness token", () => {
  // These assertions cover the mechanism the freshness contract rests on: an unchanged folder yields the
  // same `?v=` token, an edited one yields a new token. Whether a new token *re-executes* is Node's own
  // ESM-cache behavior — the test runner's transform cache does not model it, so we assert the token, not
  // a re-execution.
  it("yields the same token for an unchanged folder", async () => {
    const folder = await writePlugin("stable", validEntry());

    const first = await entryImportUrl(folder);
    const second = await entryImportUrl(folder);

    expect(second).toBe(first);
    expect(first).toMatch(/\/stable\/index\.ts\?v=\d/);
  });

  it("yields a new token after the entry file is edited", async () => {
    const folder = await writePlugin("edited", validEntry("v1"));
    const before = await entryImportUrl(folder);

    const future = new Date(Date.now() + 10_000);
    await writeFile(join(folder, "index.ts"), validEntry("v2"));
    await utimes(join(folder, "index.ts"), future, future);

    const after = await entryImportUrl(folder);
    expect(after).not.toBe(before);
  });

  it("yields a new token when a sibling file in the tree changes (max mtime across the folder)", async () => {
    const folder = await writePlugin("with-sibling", validEntry());
    const before = await entryImportUrl(folder);

    const future = new Date(Date.now() + 10_000);
    const helper = join(folder, "helper.ts");
    await writeFile(helper, "export const x = 1;\n");
    await utimes(helper, future, future);

    const after = await entryImportUrl(folder);
    expect(after).not.toBe(before);
  });
});

describe("the scanned registry feeds the schema factory (via the factory)", () => {
  // The scanner assembles entries in the seam's shape; the deeper invariants — a `fields` key colliding
  // with `commonStepFields` — are the factory's, thrown when makeWorkflowFileSchema freezes (ADR 0018
  // sub-4). This proves the assembled registry is what the factory consumes.
  it("builds a schema from a well-formed scanned registry", async () => {
    await writePlugin("api-call", zodEntry("endpoint"));

    const registry = await scanStepPlugins(root);

    expect(() => makeWorkflowFileSchema(registry)).not.toThrow();
  });

  it("surfaces a fields key colliding with an envelope field at freeze", async () => {
    // `publish` is a `commonStepFields` key the envelope owns; the factory rejects it loud.
    await writePlugin("api-call", zodEntry("publish"));

    const registry = await scanStepPlugins(root);

    expect(() => makeWorkflowFileSchema(registry)).toThrow(/collides with an envelope field/);
  });
});

describe("STEP_PLUGINS_DIR", () => {
  it("resolves the one fixed location relative to import.meta.url, not the cwd", async () => {
    expect(STEP_PLUGINS_DIR).toMatch(/packages\/engine\/step-plugins\/?$/);
    // Absolute — never a cwd-relative fragment (ADR 0019 sub-8).
    expect(STEP_PLUGINS_DIR.startsWith("/")).toBe(true);
  });
});
