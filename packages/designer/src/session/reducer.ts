import { must, type WorkflowFile, type WorkflowNode } from "@path/schema";
import { sameEditKey } from "../edit-key.js";
import { editFile, findById, unwrapEdit } from "../edit-tree.js";
import { relativeRefPath, resolveRefPath } from "../resolve-ref.js";
import { canonicalSerialize } from "../serialize.js";
import {
  type Frame,
  freshHistory,
  type History,
  loadingFrame,
  type OpenedResult,
  openedResultOf,
  scratchFrame,
  withSavePoint,
} from "./frame.js";
import { IDLE, type SessionAction, type SessionState } from "./state.js";

/** A read the session has asked for: the loading frame to fetch, where it lands, and the token a
 * landing must echo to prove it is still the current one. */
export interface FetchRequest {
  frame: Frame;
  depth: number;
  token: number;
}

/** What one action produced: the next state, and the read the caller must now perform — `null` when
 * the action asked for none. */
export interface SessionOutcome {
  state: SessionState;
  fetch: FetchRequest | null;
}

/** The actions that start a read, and therefore put a fetch in flight. */
const READS = new Set<SessionAction["type"]>([
  "openLoading",
  "openTemplateLoading",
  "descend",
  "reload",
]);

/** The token a read is stamped with: one more than the last, so a landing from a trail the author
 * has since replaced can never match a live frame's. */
function nextToken(state: SessionState): number {
  return (state.loadToken ?? 0) + 1;
}

/**
 * The one pure `(state, action) => outcome` behind the whole session: the state transition, plus the
 * read the transition asks for, already resolved to the frame it will land in. A caller performs the
 * read and echoes the token back; it never has to work out what is in flight.
 */
export function reduceSession(state: SessionState, action: SessionAction): SessionOutcome {
  const next = advance(state, action);
  // Every reading action leaves its freshly loading frame active, so the fetch is that frame.
  const active = next.frames[next.activeIndex];
  const fetch =
    READS.has(action.type) && active?.loadSeq != null
      ? { frame: active, depth: next.activeIndex, token: active.loadSeq }
      : null;
  return { state: next, fetch };
}

function advance(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case "openLoading": {
      const token = nextToken(state);
      return {
        mode: "workflow",
        frames: [loadingFrame(action.path, undefined, token)],
        activeIndex: 0,
        saveState: IDLE,
        loadToken: token,
      };
    }

    case "newFile":
      return { mode: "workflow", frames: [scratchFrame()], activeIndex: 0, saveState: IDLE };

    case "newTemplate":
      return { mode: "template", frames: [scratchFrame()], activeIndex: 0, saveState: IDLE };

    case "switchMode":
      return { mode: action.mode, frames: [], activeIndex: 0, saveState: IDLE };

    case "deleted": {
      const root = state.frames[0];
      const plan = action.plan;
      const stillOpen =
        plan.kind === "template"
          ? root?.template?.id === plan.id
          : root?.path === plan.path && !root.template;
      if (!stillOpen) return { ...state, saveState: IDLE };
      return { mode: state.mode, frames: [], activeIndex: 0, saveState: { phase: "deleted" } };
    }

    case "openTemplateLoading": {
      const token = nextToken(state);
      return {
        mode: "template",
        frames: [loadingFrame(null, undefined, token, action.template)],
        activeIndex: 0,
        saveState: IDLE,
        loadToken: token,
      };
    }

    case "descend": {
      const depth = state.activeIndex;
      const active = state.frames[depth];
      // No active frame, or a from-scratch one with no path: there is no file to resolve the ref
      // against.
      if (!active || active.path === null) return state;
      const path = resolveRefPath(active.path, action.ref);
      // Re-entry down the same trail: the frame just ahead already holds the target, so return to
      // its live buffer rather than reloading a dirty child out from under the author.
      const ahead = state.frames[depth + 1];
      if (ahead && ahead.path === path) {
        return { ...state, activeIndex: depth + 1, saveState: IDLE };
      }
      // Otherwise truncate the forward trail and load fresh; `nodeId` feeds the breadcrumb's run
      // badge.
      const token = nextToken(state);
      return {
        mode: state.mode,
        frames: [...state.frames.slice(0, depth + 1), loadingFrame(path, action.nodeId, token)],
        activeIndex: depth + 1,
        saveState: IDLE,
        loadToken: token,
      };
    }

    case "descendNewUnbound": {
      const depth = state.activeIndex;
      if (!state.frames[depth]) return state;
      const childDepth = depth + 1;
      const child = scratchFrame(null, { depth, nodeId: action.parentNodeId });
      return {
        mode: state.mode,
        frames: [...state.frames.slice(0, childDepth), child],
        activeIndex: childDepth,
        saveState: IDLE,
      };
    }

    case "goTo": {
      const activeIndex =
        action.index < 0 || action.index >= state.frames.length ? state.activeIndex : action.index;
      return { ...state, activeIndex, saveState: IDLE };
    }

    case "applyEdit": {
      const depth = state.activeIndex;
      const frame = state.frames[depth];
      const opened = openedResultOf(frame);
      if (!frame || !opened) return { ...state, saveState: IDLE };
      // A field edit whose identity matches the run in progress folds — undo jumps to where the run
      // began. Any other edit pushes the present as a new entry; either way redo is cleared.
      const fold = action.key !== undefined && sameEditKey(action.key, frame.history.coalesceKey);
      const past = fold ? frame.history.past : [...frame.history.past, opened.file];
      return withBuffer(state, depth, frame, action.next, {
        past,
        future: [],
        coalesceKey: action.key,
      });
    }

    case "undo": {
      const depth = state.activeIndex;
      const frame = state.frames[depth];
      const opened = openedResultOf(frame);
      // Nothing to undo is a true no-op, keeping a standing "Saved"/conflict phase.
      if (!frame || !opened) return state;
      const past = frame.history.past.slice();
      const restored = past.pop();
      if (restored === undefined) return state;
      // The present moves to the redo stack; clean re-derives against the unchanged baseline, so an
      // undo past the save-point re-dirties for free (ADR 0030). Closing the coalesce run opens a
      // fresh entry next.
      return withBuffer(state, depth, frame, restored, {
        past,
        future: [opened.file, ...frame.history.future],
        coalesceKey: undefined,
      });
    }

    case "redo": {
      const depth = state.activeIndex;
      const frame = state.frames[depth];
      const opened = openedResultOf(frame);
      if (!frame || !opened) return state;
      const future = frame.history.future.slice();
      const restored = future.shift();
      if (restored === undefined) return state;
      return withBuffer(state, depth, frame, restored, {
        past: [...frame.history.past, opened.file],
        future,
        coalesceKey: undefined,
      });
    }

    case "reload": {
      const depth = state.activeIndex;
      const frame = state.frames[depth];
      // An unwritten buffer has no on-disk bytes to re-fetch; a template frame has no path but
      // re-reads by id.
      if (!frame?.written || (frame.path === null && !frame.template)) return state;
      const frames = state.frames.slice();
      // A reload keeps the frame's descent origin, so a re-fetched child still badges its run
      // status.
      const token = nextToken(state);
      frames[depth] = loadingFrame(frame.path, frame.descendedVia, token, frame.template);
      return { ...state, frames, saveState: IDLE, loadToken: token };
    }

    case "loadLanded": {
      const { depth, token } = action;
      // The staleness guard: patch in only when the frame at `depth` still awaits this exact fetch;
      // a frame the author left, replaced, or that already landed holds a different token, so its
      // result is dropped.
      if (state.frames[depth]?.loadSeq !== token) return state;
      const frames = state.frames.slice();
      frames[depth] = {
        path: action.path,
        written: true,
        state: action.frameState,
        etag: action.etag,
        baseline: action.baseline,
        openedBytes: action.openedBytes,
        history: freshHistory(),
        // Carry the descent origin and template across the fetch.
        descendedVia: frames[depth]?.descendedVia,
        loadSeq: null,
        template: frames[depth]?.template,
      };
      return { ...state, frames };
    }

    case "saveStarted":
      return { ...state, saveState: { phase: "saving" } };

    // A landing save advances the frame only if it is still the one written; each case below states
    // what "still the saved frame" means for its door, and `landSave` does the rest.
    case "saved":
      return landSave(
        state,
        action.depth,
        (frame) => frame.path === action.path,
        (frame) =>
          withFrame(state, action.depth, withSavePoint(frame, action.etag, action.savedBytes)),
      );

    case "templateSaved":
      return landSave(
        state,
        action.depth,
        (frame) => frame.template?.id === action.id,
        (frame) =>
          withFrame(state, action.depth, withSavePoint(frame, action.etag, action.savedBytes)),
      );

    // A from-scratch buffer's first save: it is still that buffer while it is unwritten and
    // path-less.
    case "newFileSaved":
      return landSave(
        state,
        action.depth,
        (frame) => !frame.written && frame.path === null,
        (frame) => landNewFile(state, frame, action),
      );

    // `fromId: null` is a new template's first save: the frame held no template yet.
    case "templateSavedAs":
      return landSave(
        state,
        action.depth,
        (frame) => (frame.template?.id ?? null) === action.fromId,
        (frame, opened) =>
          withFrame(state, action.depth, {
            ...frame,
            template: action.template,
            ...savedBuffer(action.file, action.etag, opened),
          }),
      );

    // A detached copy saved as a plain workflow replaces the whole session with that one file.
    case "detachedSaved":
      return landSave(
        state,
        action.depth,
        (_frame, opened) => opened.file.id === action.fromId,
        () => ({
          mode: "workflow",
          frames: [
            { path: action.relativePath, loadSeq: null, ...savedBuffer(action.file, action.etag) },
          ],
          activeIndex: 0,
          saveState: IDLE,
        }),
      );

    case "setSaveState":
      return { ...state, saveState: action.saveState };
  }
}

/** `state` with the frame at `depth` replaced. */
function withFrame(state: SessionState, depth: number, frame: Frame): SessionState {
  const frames = state.frames.slice();
  frames[depth] = frame;
  return { ...state, frames };
}

/** An edit, undo or redo: the active frame's buffer becomes `file`, under `history`. */
function withBuffer(
  state: SessionState,
  depth: number,
  frame: Frame,
  file: WorkflowFile,
  history: History,
): SessionState {
  const opened = must(openedResultOf(frame), "opened result of the edited frame");
  const next = withFrame(state, depth, {
    ...frame,
    state: { phase: "open", result: { ...opened, file } },
    history,
  });
  return { ...next, activeIndex: depth, saveState: IDLE };
}

/**
 * Land a save on the frame at `depth`; the phase is `saved` either way, but `land` runs only while
 * `stillSaved` holds.
 */
function landSave(
  state: SessionState,
  depth: number,
  stillSaved: (frame: Frame, opened: OpenedResult) => boolean,
  land: (frame: Frame, opened: OpenedResult) => SessionState,
): SessionState {
  const frame = state.frames[depth];
  const opened = openedResultOf(frame);
  const landed = frame && opened && stillSaved(frame, opened) ? land(frame, opened) : state;
  return { ...landed, saveState: { phase: "saved" } };
}

/** A buffer that now matches what is on disk: written, open on `file`, its save point at `file`'s
 * bytes. */
function savedBuffer(
  file: WorkflowFile,
  etag: string,
  opened?: OpenedResult,
): Omit<Frame, "path" | "loadSeq"> {
  const bytes = canonicalSerialize(file);
  return {
    written: true,
    state: {
      phase: "open",
      result: opened ? { ...opened, file } : { status: "opened", file, idsStamped: false },
    },
    etag,
    baseline: bytes,
    openedBytes: bytes,
    history: freshHistory(),
  };
}

/**
 * A create-new child's first save: the child adopts its server path and drops its `refParent`, and
 * the parent's `workflow` node gets its `ref` back-filled.
 */
function landNewFile(
  state: SessionState,
  child: Frame,
  action: Extract<SessionAction, { type: "newFileSaved" }>,
): SessionState {
  const frames = state.frames.slice();
  frames[action.depth] = {
    ...withSavePoint(child, action.etag, action.savedBytes),
    path: action.relativePath,
    refParent: undefined,
  };
  const link = child.refParent;
  const parent = link ? frames[link.depth] : undefined;
  const parentResult = openedResultOf(parent);
  if (link && parent && parentResult && parent.path !== null) {
    const node = findById(parentResult.file.body, link.nodeId);
    if (node && node.type === "workflow") {
      const ref = relativeRefPath(parent.path, action.relativePath);
      const nextParent = unwrapEdit(
        editFile(parentResult.file, {
          kind: "replace",
          id: link.nodeId,
          node: { ...node, ref } as WorkflowNode,
        }),
      );
      frames[link.depth] = {
        ...parent,
        state: { phase: "open", result: { ...parentResult, file: nextParent } },
      };
    }
  }
  return { ...state, frames };
}
