import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AuthoredLayout, authoredLayout } from "../src/authored-layout.js";
import { loadAuthoredWorkflow, locateAuthoredFile } from "../src/authored-read.js";
import { strongEtag } from "../src/etag.js";

let projectDir: string;
let layout: AuthoredLayout;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "path-authored-read-"));
  layout = authoredLayout({
    projectDir,
    shippedDir: {
      workflow: join(projectDir, "install", "shipped", "workflow"),
      template: join(projectDir, "install", "shipped", "template"),
    },
  });
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

function write(relPath: string, text = "{}"): string {
  const abs = join(projectDir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  return abs;
}

describe("locateAuthoredFile — the one handle-to-bytes read", () => {
  it("resolves an in-view file to its confined path, bytes and strong ETag", () => {
    const text = '{"format":"path/workflow@6"}';
    const absPath = write("users/local/workflow/a.workflow.json", text);

    const read = locateAuthoredFile(layout, "users/local/workflow/a.workflow.json");
    expect(read).toEqual({
      ok: true,
      file: { absPath, bytes: Buffer.from(text), etag: strongEtag(Buffer.from(text)) },
    });
  });

  it("reads a shared workflow too", () => {
    write("shared/workflow/team/b.workflow.json");
    expect(locateAuthoredFile(layout, "shared/workflow/team/b.workflow.json").ok).toBe(true);
  });

  it("reports a missing file", () => {
    expect(locateAuthoredFile(layout, "users/local/workflow/none.workflow.json")).toEqual({
      ok: false,
      miss: "missing",
    });
  });

  it("reports a lexical escape", () => {
    expect(locateAuthoredFile(layout, "../outside.workflow.json")).toEqual({
      ok: false,
      miss: "escapes-root",
    });
  });

  it("reports a symlink as an escape, even when it points inside", () => {
    const target = write("users/local/workflow/target.workflow.json");
    const link = join(projectDir, "users/local/workflow/link.workflow.json");
    symlinkSync(target, link);
    expect(locateAuthoredFile(layout, "users/local/workflow/link.workflow.json")).toEqual({
      ok: false,
      miss: "escapes-root",
    });
  });

  it("reads another user's path as outside the view in hosted mode (ADR 0088)", () => {
    const hosted = authoredLayout({
      projectDir,
      userId: "mine",
      hosted: true,
      shippedDir: {
        workflow: join(projectDir, "install", "shipped", "workflow"),
        template: join(projectDir, "install", "shipped", "template"),
      },
    });
    write("users/someone/workflow/a.workflow.json");
    expect(locateAuthoredFile(hosted, "users/someone/workflow/a.workflow.json")).toEqual({
      ok: false,
      miss: "outside-view",
    });
  });

  it("tells a missing file from an escape", () => {
    expect(locateAuthoredFile(layout, "users/local/workflow/new.workflow.json")).toEqual({
      ok: false,
      miss: "missing",
    });
    expect(locateAuthoredFile(layout, "../escape.workflow.json")).toEqual({
      ok: false,
      miss: "escapes-root",
    });
  });
});

describe("loadAuthoredWorkflow — the one path-to-workflow load", () => {
  it("loads and validates a real workflow file", async () => {
    const absPath = write(
      "users/local/workflow/a.workflow.json",
      JSON.stringify({
        format: "path/workflow@6",
        id: "2e221c5d-e533-415d-8a6f-bf0dbaba09bf",
        name: "a",
        body: [
          {
            type: "binary",
            id: "3a0d58a7-99cb-4282-b858-c36d3cf36900",
            name: "step",
            command: "echo",
          },
        ],
      }),
    );
    const loaded = await loadAuthoredWorkflow(layout, absPath);
    expect(loaded.success).toBe(true);
  });

  it("reports an invalid file as coded issues, not a throw", async () => {
    const absPath = write("users/local/workflow/bad.workflow.json", "{}");
    const loaded = await loadAuthoredWorkflow(layout, absPath);
    expect(loaded.success).toBe(false);
    if (!loaded.success) expect(loaded.issues.length).toBeGreaterThan(0);
  });
});
