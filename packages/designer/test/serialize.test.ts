import { FORMAT_VERSION } from "@path/schema";
import { describe, expect, it } from "vitest";
import { openWorkflowFile } from "../src/open-workflow.js";
import { canonicalSerialize } from "../src/serialize.js";
import { DEFAULT_PLUGINS } from "./stub-server.js";

function uuid(n: number): string {
  return `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
}

function file(): Record<string, unknown> {
  return {
    format: FORMAT_VERSION,
    id: uuid(1),
    name: "flow",
    body: [
      { type: "prompt", id: uuid(2), name: "draft", prompt: "hi" },
      { type: "binary", id: uuid(3), name: "build", command: "make" },
    ],
  };
}

describe("canonicalSerialize (ADR 0030)", () => {
  it("is byte-identical to the write route's serializer — 2-space indent, one trailing newline", () => {
    const opened = openWorkflowFile(JSON.stringify(file()), DEFAULT_PLUGINS);
    if (opened.status !== "opened") throw new Error(opened.status);
    // The write route writes `JSON.stringify(workflow, null, 2)` + "\n" (put-workflow.ts) and hashes those
    // exact bytes for its ETag; the client's canonical serializer must not drift from that byte source.
    expect(canonicalSerialize(opened.file)).toBe(`${JSON.stringify(opened.file, null, 2)}\n`);
    expect(canonicalSerialize(opened.file).endsWith("\n")).toBe(true);
  });

  it("is a fixed point: re-opening its own output re-serializes to identical bytes", () => {
    const opened = openWorkflowFile(JSON.stringify(file()), DEFAULT_PLUGINS);
    if (opened.status !== "opened") throw new Error(opened.status);
    const once = canonicalSerialize(opened.file);
    const reopened = openWorkflowFile(once, DEFAULT_PLUGINS);
    if (reopened.status !== "opened") throw new Error(reopened.status);
    // Idempotency is what makes a Designer-saved file re-open clean: its on-disk bytes are this fixed point.
    expect(canonicalSerialize(reopened.file)).toBe(once);
  });
});
