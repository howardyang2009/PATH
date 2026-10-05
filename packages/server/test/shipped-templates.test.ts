import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadStepPluginRegistry } from "@path/engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authoredLayout } from "../src/authored-layout.js";
import { openCreatorTable } from "../src/creator-table.js";
import { discoverTemplates } from "../src/template-store.js";

/**
 * The templates shipped in `packages/server/shipped/template/` (#578, #579) are read-only source
 * every project sees, so a broken one is a broken palette card for everyone. Pin that each one is
 * valid against the registry the Server really loads.
 */

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "path-shipped-templates-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe("shipped templates", () => {
  it("ship at least one step-template, and every shipped template is valid", async () => {
    const registry = await loadStepPluginRegistry();
    const { entries } = discoverTemplates(
      authoredLayout({ projectDir: projectDir }),
      registry,
      openCreatorTable(":memory:"),
    );

    expect(entries.some((entry) => entry.kind === "step")).toBe(true);
    for (const entry of entries) {
      expect(entry.origin).toBe("shipped");
      expect({ name: entry.name, valid: entry.valid, error: entry.error }).toEqual({
        name: entry.name,
        valid: true,
        error: null,
      });
    }
  });
});
