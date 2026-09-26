import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkPrecondition, readArtifact, writeArtifact } from "../src/artifact-file.js";
import { strongEtag } from "../src/etag.js";

/**
 * The versioned artifact file (`artifact-file.ts`) through its own interface, on a temp dir and no
 * HTTP: the `If-Match` rules every write door shares, and the create-only / overwrite write.
 */

const bytes = Buffer.from('{"a":1}\n', "utf8");

describe("checkPrecondition", () => {
  it("create-or-overwrite: absent If-Match creates a missing file and refuses an existing one", () => {
    expect(checkPrecondition(undefined, undefined, "create-or-overwrite")).toEqual({ ok: true, create: true });
    expect(checkPrecondition(bytes, undefined, "create-or-overwrite")).toEqual({ ok: false, conflict: "exists" });
  });

  it("a present If-Match overwrites only a matching file", () => {
    expect(checkPrecondition(bytes, strongEtag(bytes), "create-or-overwrite")).toEqual({ ok: true, create: false });
    expect(checkPrecondition(bytes, '"stale"', "overwrite")).toEqual({ ok: false, conflict: "changed" });
    expect(checkPrecondition(bytes, "*", "overwrite")).toEqual({ ok: false, conflict: "changed" });
    expect(checkPrecondition(undefined, strongEtag(bytes), "overwrite")).toEqual({ ok: false, conflict: "missing" });
  });

  it("overwrite: If-Match is required", () => {
    expect(checkPrecondition(bytes, undefined, "overwrite")).toEqual({ ok: false, conflict: "required" });
  });
});

describe("writeArtifact", () => {
  it("serializes with key order kept and returns the new bytes' etag, creating directories", () => {
    const path = join(mkdtempSync(join(tmpdir(), "artifact-")), "nested", "a.json");
    const written = writeArtifact(path, { z: 1, a: 2 }, { create: true });
    const onDisk = readFileSync(path);
    expect(onDisk.toString("utf8")).toBe('{\n  "z": 1,\n  "a": 2\n}\n');
    expect(written).toEqual({ ok: true, etag: strongEtag(onDisk) });
    expect(readArtifact(path)).toEqual(onDisk);
  });

  it("a create never clobbers an existing file", () => {
    const path = join(mkdtempSync(join(tmpdir(), "artifact-")), "a.json");
    writeFileSync(path, "keep");
    expect(writeArtifact(path, {}, { create: true })).toEqual({ ok: false, conflict: "exists" });
    expect(readFileSync(path, "utf8")).toBe("keep");
  });

  it("an overwrite replaces the bytes", () => {
    const path = join(mkdtempSync(join(tmpdir(), "artifact-")), "a.json");
    writeFileSync(path, "old");
    expect(writeArtifact(path, { b: 1 }, { create: false }).ok).toBe(true);
    expect(readFileSync(path, "utf8")).toBe('{\n  "b": 1\n}\n');
  });

  it("reads a missing file as undefined", () => {
    expect(readArtifact(join(tmpdir(), "no-such-artifact.json"))).toBeUndefined();
  });
});
