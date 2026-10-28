import { verbatim } from "@path/i18n";
import type { WorkflowFile } from "@path/schema";
import { describe, expect, it } from "vitest";
import type { DocumentPolicy } from "../src/document.js";
import { editorChrome } from "../src/editor-chrome.js";
import type { LeaseState } from "../src/lease-client.js";
import { canonicalSerialize } from "../src/serialize.js";
import {
  type Frame,
  freshHistory,
  initialSessionState,
  type SessionState,
  scratchFrame,
} from "../src/session-reducer.js";

function fileOf(frame: Frame): WorkflowFile {
  if (frame.state.phase !== "open" || frame.state.result.status !== "opened") {
    throw new Error("frame is not open");
  }
  return frame.state.result.file;
}

/** A frame with no unsaved work: its buffer equals its baseline. */
function cleanFrame(): Frame {
  const frame = scratchFrame();
  return { ...frame, baseline: canonicalSerialize(fileOf(frame)) };
}

/** A frame with unsaved work: a scratch buffer's baseline is empty. */
function dirtyFrame(): Frame {
  return scratchFrame();
}

/** The capability value over one active frame, at the phase, policy and lease a test names. */
function chrome(
  frame: Frame,
  overrides: Partial<DocumentPolicy> & { lease?: LeaseState } = {},
  session: Partial<SessionState> = {},
) {
  const { lease, ...policy } = overrides;
  return editorChrome(
    { ...initialSessionState, frames: [frame], activeIndex: 0, ...session },
    { canSaveAs: true, readOnly: false, deletePlan: null, downloadPlan: null, ...policy },
    lease,
  );
}

describe("editorChrome — the toolbar's one capability value", () => {
  it("enables Save only for a dirty, writable document at rest", () => {
    expect(chrome(dirtyFrame())).toMatchObject({
      save: true,
      saveLabel: { key: "designer.editingToolbar.save" },
      busy: false,
    });
    expect(chrome(cleanFrame()).save).toBe(false);
  });

  it("blocks Save while a write is in flight or a conflict stands, and says so on the label", () => {
    const saving = chrome(dirtyFrame(), {}, { saveState: { phase: "saving" } });
    expect(saving).toMatchObject({
      save: false,
      busy: true,
      saveLabel: { key: "designer.editingToolbar.saving" },
    });

    expect(chrome(dirtyFrame(), {}, { saveState: { phase: "deleting" } }).busy).toBe(true);
    expect(
      chrome(dirtyFrame(), {}, { saveState: { phase: "conflict", message: verbatim("changed") } })
        .save,
    ).toBe(false);
  });

  it("keeps Save and Delete off a read-only document, while Save as… stays", () => {
    // The policy drops a read-only document's delete plan, so Delete is off with it.
    const readOnly = chrome(dirtyFrame(), { readOnly: "shipped" });
    expect(readOnly).toMatchObject({
      save: false,
      remove: false,
      saveAs: true,
      readOnly: "shipped",
    });
  });

  it("reads Delete and Download off the two plans, and passes the lease through", () => {
    expect(chrome(dirtyFrame())).toMatchObject({
      remove: false,
      download: false,
      lease: undefined,
    });

    const planned = chrome(dirtyFrame(), {
      deletePlan: { kind: "workflow", path: "flow.workflow.json", ifMatch: "e" },
      downloadPlan: { kind: "workflow", path: "flow.workflow.json" },
      lease: { phase: "held", expiresAt: "2026-01-01T00:00:00.000Z" },
    });
    expect(planned).toMatchObject({ remove: true, download: true, lease: { phase: "held" } });
  });

  it("reads Undo and Redo off the active frame's own history", () => {
    const frame = cleanFrame();
    expect(chrome(frame)).toMatchObject({ undo: false, redo: false });

    const past = freshHistory();
    past.past.push(fileOf(frame));
    expect(chrome({ ...frame, history: past })).toMatchObject({ undo: true, redo: false });

    const future = freshHistory();
    future.future.push(fileOf(frame));
    expect(chrome({ ...frame, history: future })).toMatchObject({ undo: false, redo: true });
  });
});
