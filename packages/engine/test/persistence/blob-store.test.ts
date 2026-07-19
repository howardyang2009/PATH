import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dirExists, readJsonBlob, removeDir, writeBlobFile, writeJsonBlob } from "../../src/persistence/blob-store.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "path-engine-blob-store-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("blob-store", () => {
  it("writes a text blob, creating the directory if needed", () => {
    const target = join(dir, "nested", "run-1");
    writeBlobFile(target, "stderr.txt", "boom\n");
    expect(readFileSync(join(target, "stderr.txt"), "utf8")).toBe("boom\n");
  });

  it("leaves no temp file behind after a write", () => {
    writeBlobFile(dir, "output.json", "{}");
    expect(readdirSync(dir)).toEqual(["output.json"]);
  });

  it("writeJsonBlob serializes a JSON value, and readJsonBlob reads it back", () => {
    writeJsonBlob(dir, "context.json", { greeting: "hi", n: 3 });
    expect(readJsonBlob(dir, "context.json")).toEqual({ greeting: "hi", n: 3 });
  });

  it("overwrites an existing blob atomically (readers never see a partial file)", () => {
    writeJsonBlob(dir, "context.json", { v: 1 });
    writeJsonBlob(dir, "context.json", { v: 2 });
    expect(readJsonBlob(dir, "context.json")).toEqual({ v: 2 });
    expect(readdirSync(dir)).toEqual(["context.json"]);
  });

  it("dirExists reports whether a directory is present", () => {
    expect(dirExists(join(dir, "nope"))).toBe(false);
    writeBlobFile(join(dir, "present"), "x.txt", "x");
    expect(dirExists(join(dir, "present"))).toBe(true);
  });

  it("removeDir deletes a directory tree and is a no-op if it doesn't exist", () => {
    const target = join(dir, "to-remove");
    writeBlobFile(target, "x.txt", "x");
    expect(existsSync(target)).toBe(true);

    removeDir(target);
    expect(existsSync(target)).toBe(false);

    expect(() => removeDir(target)).not.toThrow();
  });
});
