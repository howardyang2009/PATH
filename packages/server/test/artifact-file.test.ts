import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { conditionalDelete, conditionalWrite, readArtifact } from "../src/artifact-file.js";
import { strongEtag } from "../src/etag.js";

/**
 * The versioned artifact file (`artifact-file.ts`) through its own interface, on a temp dir and no
 * HTTP: the `If-Match` rules and the create-only / overwrite / remove outcomes every write door
 * shares. The read-and-decide half is private on purpose — a door that could check a token without
 * writing could also leave an `await` between the two.
 */

const bytes = Buffer.from('{"a":1}\n', "utf8");

function tempPath(name = "a.json"): string {
  return join(mkdtempSync(join(tmpdir(), "artifact-")), name);
}

describe("conditionalWrite", () => {
  it("create-or-overwrite: an absent If-Match creates a missing file", () => {
    const path = tempPath();
    const written = conditionalWrite(path, {
      ifMatch: undefined,
      rule: "create-or-overwrite",
      payload: { z: 1, a: 2 },
    });
    const onDisk = readFileSync(path);
    expect(onDisk.toString("utf8")).toBe('{\n  "z": 1,\n  "a": 2\n}\n');
    expect(written).toEqual({ ok: true, etag: strongEtag(onDisk), created: true });
  });

  it("create-or-overwrite: an absent If-Match refuses an existing file", () => {
    const path = tempPath();
    writeFileSync(path, "keep");
    expect(
      conditionalWrite(path, { ifMatch: undefined, rule: "create-or-overwrite", payload: {} }),
    ).toEqual({ ok: false, conflict: "exists" });
    expect(readFileSync(path, "utf8")).toBe("keep");
  });

  it("a matching If-Match overwrites, reporting that it was not a create", () => {
    const path = tempPath();
    writeFileSync(path, bytes);
    const written = conditionalWrite(path, {
      ifMatch: strongEtag(bytes),
      rule: "overwrite",
      payload: { b: 1 },
    });
    expect(written.ok && written.created).toBe(false);
    expect(readFileSync(path, "utf8")).toBe('{\n  "b": 1\n}\n');
  });

  it("a stale or missing token never touches the file", () => {
    const path = tempPath();
    writeFileSync(path, bytes);
    expect(conditionalWrite(path, { ifMatch: '"stale"', rule: "overwrite", payload: {} })).toEqual({
      ok: false,
      conflict: "changed",
    });
    expect(conditionalWrite(path, { ifMatch: "*", rule: "overwrite", payload: {} })).toEqual({
      ok: false,
      conflict: "changed",
    });
    expect(
      conditionalWrite(tempPath("gone.json"), {
        ifMatch: strongEtag(bytes),
        rule: "overwrite",
        payload: {},
      }),
    ).toEqual({ ok: false, conflict: "missing" });
    expect(readFileSync(path, "utf8")).toBe(bytes.toString("utf8"));
  });

  it("overwrite: If-Match is required", () => {
    const path = tempPath();
    writeFileSync(path, bytes);
    expect(conditionalWrite(path, { ifMatch: undefined, rule: "overwrite", payload: {} })).toEqual({
      ok: false,
      conflict: "required",
    });
  });
});

describe("conditionalDelete", () => {
  it("removes a file under a matching token", () => {
    const path = tempPath();
    writeFileSync(path, bytes);
    expect(conditionalDelete(path, strongEtag(bytes))).toEqual({ ok: true });
    expect(readArtifact(path)).toBeUndefined();
  });

  it("refuses an absent token and a stale one, keeping the file", () => {
    const path = tempPath();
    writeFileSync(path, bytes);
    expect(conditionalDelete(path, undefined)).toEqual({ ok: false, conflict: "required" });
    expect(conditionalDelete(path, '"stale"')).toEqual({ ok: false, conflict: "changed" });
    expect(readFileSync(path, "utf8")).toBe(bytes.toString("utf8"));
  });

  it("reads a file that is already gone as missing, not as a stale token", () => {
    expect(conditionalDelete(tempPath("gone.json"), strongEtag(bytes))).toEqual({
      ok: false,
      conflict: "missing",
    });
  });
});

describe("readArtifact", () => {
  it("reads a missing file as undefined", () => {
    expect(readArtifact(join(tmpdir(), "no-such-artifact.json"))).toBeUndefined();
  });
});
