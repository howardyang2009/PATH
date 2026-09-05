import { FORMAT_VERSION, type WorkflowFile } from "@path/schema";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { canonicalSerialize } from "../src/serialize.js";
import { frameCanRedo, frameCanUndo, frameDirty, openedResultOf, useOpenFile } from "../src/use-open-file.js";
import { DEFAULT_PLUGINS, makeCalls, stubClient } from "./stub-server.js";

/**
 * The per-file undo/redo stack (#389, designer-spec § Dirty-state, undo, and the save-point). These drive
 * the session hook directly — an undo/redo is a plain state transition on a frame, so the assertions read
 * `frameCanUndo` / `frameDirty` off the frame rather than round-tripping the UI. The stack rests on the
 * content-equality clean model (ADR 0030): the save advances the baseline, not the history, so an undo
 * past the save-point re-dirties for free.
 */

function uuid(n: number): string {
  return `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
}

/** A canonical, fully-id'd single-step file with the given step `name`. */
function file(name: string): Record<string, unknown> {
  return { format: FORMAT_VERSION, id: uuid(1), name: "flow", body: [{ type: "prompt", id: uuid(2), name, prompt: "hi" }] };
}

const PATH = "flows/main.workflow.json";

async function openSession(files: Record<string, string>, extra: Parameters<typeof stubClient>[0] = {}) {
  const client = stubClient({ files, ...extra });
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

/** Rename the active buffer's first body step, keeping the rest of the file byte-stable. */
function rename(base: WorkflowFile, name: string): WorkflowFile {
  return { ...base, body: [{ ...base.body[0]!, name }] } as WorkflowFile;
}

describe("#389 undo/redo — one entry per structural edit, clean re-derived (ADR 0030)", () => {
  it("undoes and redoes an edit, restoring the buffer either way", async () => {
    const hook = await openSession({ [PATH]: JSON.stringify(file("draft")) });
    const original = buffer(hook);

    // A structural rename is one entry; undo restores the original, redo re-applies it.
    act(() => hook.result.current.applyEdit(rename(original, "renamed")));
    expect(buffer(hook).body[0]!.name).toBe("renamed");
    expect(frameCanUndo(hook.result.current.frames[0])).toBe(true);

    act(() => hook.result.current.undo());
    expect(buffer(hook).body[0]!.name).toBe("draft");
    expect(canonicalSerialize(buffer(hook))).toBe(canonicalSerialize(original));
    expect(frameCanUndo(hook.result.current.frames[0])).toBe(false);
    expect(frameCanRedo(hook.result.current.frames[0])).toBe(true);

    act(() => hook.result.current.redo());
    expect(buffer(hook).body[0]!.name).toBe("renamed");
    expect(frameCanRedo(hook.result.current.frames[0])).toBe(false);
  });

  it("survives a save: undo past the save-point re-dirties, redo back re-cleans", async () => {
    const calls = makeCalls();
    const hook = await openSession({ [PATH]: JSON.stringify(file("draft")) }, { calls });
    const original = buffer(hook);

    // Edit, then save — the save advances the baseline to the edited bytes and re-cleans the buffer.
    act(() => hook.result.current.applyEdit(rename(original, "renamed")));
    act(() => hook.result.current.save());
    await waitFor(() => expect(calls.put).toHaveLength(1));
    await waitFor(() => expect(frameDirty(hook.result.current.frames[0])).toBe(false));

    // The stack survives the save: there is still an entry to undo back past the save-point.
    expect(frameCanUndo(hook.result.current.frames[0])).toBe(true);
    act(() => hook.result.current.undo());
    // Back at "draft", which no longer equals the saved-"renamed" baseline → dirty again, for free.
    expect(buffer(hook).body[0]!.name).toBe("draft");
    expect(frameDirty(hook.result.current.frames[0])).toBe(true);

    // Redo forward to the save-point bytes → clean once more (content-equality, re-evaluated each time).
    act(() => hook.result.current.redo());
    expect(buffer(hook).body[0]!.name).toBe("renamed");
    expect(frameDirty(hook.result.current.frames[0])).toBe(false);
  });

  it("clears redo on any new edit", async () => {
    const hook = await openSession({ [PATH]: JSON.stringify(file("draft")) });
    const original = buffer(hook);

    act(() => hook.result.current.applyEdit(rename(original, "one")));
    act(() => hook.result.current.undo());
    expect(frameCanRedo(hook.result.current.frames[0])).toBe(true);

    // A fresh edit past the undo point drops the redo branch.
    act(() => hook.result.current.applyEdit(rename(original, "two")));
    expect(frameCanRedo(hook.result.current.frames[0])).toBe(false);
    expect(buffer(hook).body[0]!.name).toBe("two");
  });

  it("folds a run of keystrokes in one field to a single undo entry", async () => {
    const hook = await openSession({ [PATH]: JSON.stringify(file("draft")) });
    const original = buffer(hook);

    // Three edits sharing one coalesce key fold to one entry; a single undo jumps back to the run start.
    act(() => hook.result.current.applyEdit(rename(original, "d"), "name:step"));
    act(() => hook.result.current.applyEdit(rename(original, "dr"), "name:step"));
    act(() => hook.result.current.applyEdit(rename(original, "draft-2"), "name:step"));
    expect(buffer(hook).body[0]!.name).toBe("draft-2");

    act(() => hook.result.current.undo());
    expect(buffer(hook).body[0]!.name).toBe("draft");
    expect(frameCanUndo(hook.result.current.frames[0])).toBe(false);

    // A different key opens a new entry, so it does not fold with the previous run.
    act(() => hook.result.current.redo());
    act(() => hook.result.current.applyEdit(rename(original, "other"), "prompt:step"));
    act(() => hook.result.current.undo());
    expect(buffer(hook).body[0]!.name).toBe("draft-2");
  });
});

describe("#389 per-file stack isolation — each descended ref child has its own stack", () => {
  const CHILD = "flows/child.workflow.json";

  it("keeps the parent's stack untouched while the child is edited and undone", async () => {
    const hook = await openSession({
      [PATH]: JSON.stringify(file("parent-step")),
      [CHILD]: JSON.stringify(file("child-step")),
    });

    // Descend across a ref into the child frame; wait until its own fetch-and-open lands.
    act(() => hook.result.current.descend("child.workflow.json", "wf-child"));
    await waitFor(() => expect(openedResultOf(hook.result.current.frames[1])).not.toBeNull());
    const childOriginal = buffer(hook);

    // Edit the child → the child's stack has an entry; the parent's stays empty.
    act(() => hook.result.current.applyEdit(rename(childOriginal, "child-edited")));
    expect(frameCanUndo(hook.result.current.frames[1])).toBe(true);
    expect(frameCanUndo(hook.result.current.frames[0])).toBe(false);

    // Undoing the child restores only the child; the parent buffer never moved.
    act(() => hook.result.current.undo());
    expect(buffer(hook).body[0]!.name).toBe("child-step");
    expect(openedResultOf(hook.result.current.frames[0])!.file.body[0]!.name).toBe("parent-step");
    expect(frameCanRedo(hook.result.current.frames[0])).toBe(false);
  });
});
