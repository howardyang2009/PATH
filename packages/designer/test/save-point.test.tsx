import { FORMAT_VERSION, type WorkflowFile } from "@path/schema";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { openWorkflowFile } from "../src/open-workflow.js";
import { canonicalSerialize } from "../src/serialize.js";
import { frameDirty, openedResultOf, useOpenFile } from "../src/use-open-file.js";
import { DEFAULT_PLUGINS, makeCalls, stubClient } from "./stub-server.js";

/**
 * The save-point content-equality model (#386, ADR 0030): "clean" is `canonicalSerialize(buffer) ===
 * baseline`, not a mutation flag. These drive the session hook directly so a clean/dirty transition is a
 * plain assertion on `frameDirty`, not a UI round-trip.
 */

function uuid(n: number): string {
  return `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
}

/** A fully-id'd file; `canonical()` renders the on-disk bytes a prior Designer save would have written. */
function file(): Record<string, unknown> {
  return { format: FORMAT_VERSION, id: uuid(1), name: "flow", body: [{ type: "prompt", id: uuid(2), name: "draft", prompt: "hi" }] };
}

/** The canonical (fixed-point) on-disk bytes of a fixture — what the Designer itself writes on save. */
function canonical(f: Record<string, unknown>): string {
  const opened = openWorkflowFile(JSON.stringify(f), DEFAULT_PLUGINS);
  if (opened.status !== "opened") throw new Error(opened.status);
  return canonicalSerialize(opened.file);
}

const PATH = "flows/main.workflow.json";

/** Open a session on `bytes` and wait until the root frame's fetch-and-open lands. */
async function openSession(bytes: string, extra: Parameters<typeof stubClient>[0] = {}) {
  const client = stubClient({ files: { [PATH]: bytes }, ...extra });
  const hook = renderHook(() => useOpenFile(client, PATH));
  await waitFor(() => expect(openedResultOf(hook.result.current.frames[0])).not.toBeNull());
  return hook;
}

/** The active frame's opened buffer (asserts it is open). */
function buffer(hook: Awaited<ReturnType<typeof openSession>>): WorkflowFile {
  const opened = openedResultOf(hook.result.current.frames.at(-1));
  if (!opened) throw new Error("no open buffer");
  return opened.file;
}

describe("save-point: clean is content-equality to the baseline (ADR 0030)", () => {
  it("opens a canonical, fully-id'd file clean — the baseline equals the on-disk bytes", async () => {
    const hook = await openSession(canonical(file()));
    expect(frameDirty(hook.result.current.frames[0])).toBe(false);
  });

  it("opens an id-less file dirty — the id-stamp repair changed bytes", async () => {
    const idless = file();
    delete idless.id;
    delete (idless.body as Record<string, unknown>[])[0]!.id;
    const hook = await openSession(JSON.stringify(idless));
    // The stamp is a real proposed change against the on-disk (id-less) bytes, so a save would differ.
    expect(frameDirty(hook.result.current.frames[0])).toBe(true);
    expect(openedResultOf(hook.result.current.frames[0])!.idsStamped).toBe(true);
  });

  it("goes dirty on an edit and clean again on a no-op round-trip edit", async () => {
    const hook = await openSession(canonical(file()));
    const original = buffer(hook);
    const withName = (name: string): WorkflowFile => ({ ...original, body: [{ ...original.body[0]!, name }] } as WorkflowFile);

    // Rename the step → dirty.
    const renamed = withName("renamed");
    act(() => hook.result.current.applyEdit(renamed));
    expect(frameDirty(hook.result.current.frames[0])).toBe(true);

    // Rename it back to a byte-identical buffer → clean, though a mutation happened (the ADR headline).
    const restored = withName("draft");
    act(() => hook.result.current.applyEdit(restored));
    expect(canonicalSerialize(buffer(hook))).toBe(canonicalSerialize(original));
    expect(frameDirty(hook.result.current.frames[0])).toBe(false);
  });

  it("advances the baseline only on a 200 save: an edit is dirty, the save re-cleans and re-bases", async () => {
    const calls = makeCalls();
    const hook = await openSession(canonical(file()), { calls });

    const original = buffer(hook);
    const withPrompt = (prompt: string): WorkflowFile => ({ ...original, body: [{ ...original.body[0]!, prompt }] } as WorkflowFile);
    const edited = withPrompt("changed");
    act(() => hook.result.current.applyEdit(edited));
    expect(frameDirty(hook.result.current.frames[0])).toBe(true);

    act(() => hook.result.current.save());
    await waitFor(() => expect(calls.put).toHaveLength(1));
    // The If-Match carried the baseline ETag (the read etag), and the save re-based to the written bytes.
    expect(calls.put[0]!.ifMatch).toBe('"stub"');
    await waitFor(() => expect(frameDirty(hook.result.current.frames[0])).toBe(false));
    expect(hook.result.current.frames[0]!.baseline).toBe(canonicalSerialize(edited));
    expect(hook.result.current.frames[0]!.etag).toBe('"saved"');

    // A further edit past the new save-point is dirty again.
    act(() => hook.result.current.applyEdit(withPrompt("again")));
    expect(frameDirty(hook.result.current.frames[0])).toBe(true);
  });
});
