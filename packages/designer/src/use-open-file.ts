import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { PathApiError, type JsonValue, type PathApiClient, type WireStepPlugin } from "@path/client-core";
import type { WorkflowFile } from "@path/schema";
import { openWorkflowFile } from "./open-workflow.js";
import { resolveRefPath } from "./resolve-ref.js";
import { canonicalSerialize } from "./serialize.js";
import {
  initialSessionState,
  openedResultOf,
  frameCanRedo,
  frameCanUndo,
  reduceSession,
  type Frame,
  type SaveState,
  type SessionAction,
} from "./session-reducer.js";

// The session state and its transitions live in `session-reducer.ts` — a pure `(state, action) => state`
// testable with no React and no stub server. This hook is the thin adapter: it fetches the step-plugin
// registry, runs the async `client` fetch/PUT, guards a stale completion with a monotonic token, and then
// dispatches the outcome as an action. Re-export the frame types and predicates so the reducer's split
// stays invisible to the pane, the canvas, the toolbar, and the tests that import them from here.
export { openedResultOf, frameDirty, frameCanUndo, frameCanRedo } from "./session-reducer.js";
export type { Frame, FrameState, History, SaveState, OpenedResult, SessionState, SessionAction } from "./session-reducer.js";

/**
 * The Designer's open-and-navigate session (#367): fetch the step-plugin registry once, open a file against
 * it, and track a **navigation stack** of files as a `workflow`-ref descent crosses each boundary
 * (designer-spec § The model). The stack is a trail, not a tree parent — a ref'd file can have several
 * parents — so a breadcrumb built from it pops back by index.
 *
 * The rich state — the trail, the per-frame undo history, the save-point advance — is the reducer's
 * (`session-reducer.ts`). Here the registry is fetched once and reused for every file in the session, and a
 * file fetch or open runs as one guarded async step: a stale completion (the author descended, or popped the
 * breadcrumb, before it landed) is dropped by a monotonic token before it dispatches, and by the reducer's
 * own depth+path re-check after.
 */

/** The registry fetch state — the received `GET /v0/step-plugins` snapshot the open passes are relative to. */
export type RegistryLoad =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; plugins: WireStepPlugin[] };

/**
 * The outcome of a from-scratch buffer's first save (#390, designer-spec § New-file placement and naming). A
 * new-file save is an **exclusive create** (no `If-Match`, ADR 0016): the server refuses an existing path
 * with a `412`, which reads here as `exists` — the dialog's "choose another name", never a silent overwrite.
 * `created` reports the path the server echoed; the frame is now saved. `error` is any other failure.
 */
export type SaveNewFileResult =
  | { status: "created"; path: string }
  | { status: "exists" }
  | { status: "error"; message: string };

export interface OpenSession {
  registry: RegistryLoad;
  /**
   * The navigation **trail**, root file first (#367). The frame the canvas, the pane, and the toolbar all
   * act on is `frames[activeIndex]`, **not** the tip: ascending the breadcrumb (`goTo`) moves the active
   * index without discarding the deeper frames, so a descended child keeps its dirty buffer and its beating
   * lease while the parent is on screen (#391).
   */
  frames: Frame[];
  /** The index of the active frame in `frames` — what the canvas renders and every edit/save op targets. */
  activeIndex: number;
  /** Open `path` as a fresh root, discarding any current stack. */
  open: (path: string) => void;
  /**
   * Start a **from-scratch** buffer as a fresh root, discarding any current stack (#390). The frame holds
   * **no path and no lease**: an empty, editable workflow whose placement is decided at its first
   * `saveNewFile`. Reads dirty from open, so Save is live at once.
   */
  newFile: () => void;
  /**
   * Descend across the active file's `workflow`-ref (a relative path), making a child frame active. If the
   * frame just ahead of the active one already holds that resolved target, it is **reused**; otherwise the
   * forward trail is truncated and the target is loaded fresh.
   */
  descend: (ref: string) => void;
  /**
   * Descend into a **fresh, unwritten, path-less** child buffer for a create-new nested ref (#391), linked
   * back to the `workflow` node `parentNodeId` in the active (parent) frame. Its first save also **back-fills
   * the parent node's `ref`** from the path the child is saved to. The forward trail is truncated.
   */
  descendNewUnbound: (parentNodeId: string) => void;
  /** Make the breadcrumb entry at `index` active — an ascend or a forward re-entry; no frame is discarded. */
  goTo: (index: number) => void;
  /**
   * Commit an edit to the active (last) frame's opened file; dirtiness re-derives (#368, ADR 0030) and an
   * undo entry is recorded (#389). A structural edit passes no `coalesce` key (one entry each); a field edit
   * passes a stable key so a run of keystrokes in that one field folds to a single entry. Any edit clears the
   * frame's redo stack.
   */
  applyEdit: (next: WorkflowFile, coalesce?: string) => void;
  /** Undo the active frame's last edit, re-deriving clean (#389). A no-op when its past stack is empty. */
  undo: () => void;
  /** Redo the active frame's last undo, re-deriving clean (#389). A no-op when its future stack is empty. */
  redo: () => void;
  /**
   * Save the active frame's opened buffer through `PUT /v0/workflows` under its `If-Match` ETag (#371, ADR
   * 0016). On success the buffer becomes clean (a new save-point) and the frame's ETag advances; a `412`
   * becomes a `conflict` the author resolves. A no-op when nothing is open.
   */
  save: () => void;
  /**
   * First-save a from-scratch buffer to `targetPath` as an **exclusive create** (#390, ADR 0016): a `PUT`
   * with no `If-Match`, so the server refuses an existing path (`412` → `exists`) rather than overwrite it. On
   * `created` the active frame's path, ETag, and baseline advance to the written file. A no-op — `error` —
   * when the active frame is not a `null`-path buffer.
   */
  saveNewFile: (targetPath: string) => Promise<SaveNewFileResult>;
  /**
   * Re-fetch the active frame from disk, discarding its unsaved buffer for the on-disk bytes and a fresh
   * ETag. The stale-write recovery (#371). A no-op with no file open.
   */
  reloadActive: () => void;
  /** The active frame's save state — drives the save button and the stale-write conflict banner. */
  saveState: SaveState;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Fetch one file's raw bytes and run the open pipeline; a fetch failure (404, …) becomes a frame error. */
async function loadFrame(
  client: PathApiClient,
  path: string,
  plugins: WireStepPlugin[],
): Promise<{ frameState: Frame["state"]; etag: string | null; baseline: string; openedBytes: string }> {
  try {
    const raw = await client.getWorkflowFile(path);
    const result = openWorkflowFile(raw.text, plugins);
    // The baseline is the raw on-disk bytes (ADR 0030): a buffer whose canonical serialization differs from
    // them — an id-stamp repair, or a non-canonical hand-authored file — opens dirty, because a save would
    // write different bytes. `openedBytes` is the buffer's own canonical form at open, for the badge wording.
    const openedBytes = result.status === "opened" ? canonicalSerialize(result.file) : "";
    return { frameState: { phase: "open", result }, etag: raw.etag, baseline: raw.text, openedBytes };
  } catch (error) {
    return { frameState: { phase: "fetch-error", message: errorMessage(error) }, etag: null, baseline: "", openedBytes: "" };
  }
}

/** The result of a `PUT /v0/workflows` — the fresh ETag and the server-resolved relative path. */
type PutResult = Awaited<ReturnType<PathApiClient["putWorkflow"]>>;

const IDLE: SaveState = { phase: "idle" };

export function useOpenFile(client: PathApiClient, initialPath?: string): OpenSession {
  const [registry, setRegistry] = useState<RegistryLoad>({ phase: "loading" });
  const [session, dispatch] = useReducer(reduceSession, initialSessionState);
  const { frames, activeIndex, saveState } = session;

  // A ref mirror of the reducer state, so the async callbacks read the current trail synchronously without
  // re-subscribing; and the registry plugins, so an open callback reads them without waiting on a state read.
  const sessionRef = useRef(session);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);
  const pluginsRef = useRef<WireStepPlugin[] | null>(null);

  // A monotonic token: only the newest in-flight load may dispatch its result. Bumped on every open, descend,
  // reload, and new-file, so a load whose destination the author already left never reaches the reducer. (The
  // reducer's own depth+path re-check is the second, pure guard.)
  const loadToken = useRef(0);

  useEffect(() => {
    let alive = true;
    client
      .getStepPlugins()
      .then((response) => {
        if (!alive) return;
        pluginsRef.current = response.step_plugins;
        setRegistry({ phase: "ready", plugins: response.step_plugins });
      })
      .catch((error: unknown) => {
        if (alive) setRegistry({ phase: "error", message: errorMessage(error) });
      });
    return () => {
      alive = false;
    };
  }, [client]);

  const runLoad = useCallback(
    (path: string, depth: number): void => {
      const plugins = pluginsRef.current;
      if (!plugins) return;
      const token = ++loadToken.current;
      void loadFrame(client, path, plugins).then(({ frameState, etag, baseline, openedBytes }) => {
        if (token !== loadToken.current) return;
        dispatch({ type: "loadLanded", depth, path, frameState, etag, baseline, openedBytes });
      });
    },
    [client],
  );

  const open = useCallback(
    (path: string): void => {
      if (!pluginsRef.current) return;
      dispatch({ type: "openLoading", path });
      runLoad(path, 0);
    },
    [runLoad],
  );

  const newFile = useCallback((): void => {
    // A from-scratch buffer needs no registry fetch to open. Bump the load token so any in-flight fetch
    // cannot dispatch into the discarded stack.
    loadToken.current++;
    dispatch({ type: "newFile" });
  }, []);

  const descend = useCallback(
    (ref: string): void => {
      const plugins = pluginsRef.current;
      const { frames: current, activeIndex: depth } = sessionRef.current;
      const active = current[depth];
      // A descent crosses a `workflow`-ref of the active file, so the active frame must carry a path to
      // resolve the ref against; a from-scratch root buffer (no path) has no ref to descend.
      if (!plugins || !active || active.path === null) return;
      const path = resolveRefPath(active.path, ref);
      // Re-entry down the same trail: if the frame just ahead already holds this target, reuse it — the author
      // returns to its live buffer (a dirty descended child is not reloaded out from under them).
      const ahead = current[depth + 1];
      if (ahead && ahead.path === path) {
        dispatch({ type: "descendReuse" });
        return;
      }
      // Otherwise truncate the forward trail and load the target fresh below the active frame.
      dispatch({ type: "descendLoading", path });
      runLoad(path, depth + 1);
    },
    [runLoad],
  );

  const descendNewUnbound = useCallback((parentNodeId: string): void => {
    const { frames: current, activeIndex: depth } = sessionRef.current;
    if (!current[depth]) return;
    // A create-new child is a fresh, unwritten, path-less buffer linked back to the parent node that spawned
    // it. Bump the load token so no in-flight load dispatches into the truncated trail.
    loadToken.current++;
    dispatch({ type: "descendNewUnbound", parentNodeId });
  }, []);

  const goTo = useCallback((index: number): void => {
    // An ascend (or forward re-entry) only moves the active frame — no frame is discarded, so a dirty
    // descended child keeps its buffer and its beating lease. A pending load stays valid (its frame is still
    // on the trail at the same depth), so the load token is left untouched.
    dispatch({ type: "goTo", index });
  }, []);

  const applyEdit = useCallback((next: WorkflowFile, coalesce?: string): void => {
    dispatch({ type: "applyEdit", next, coalesce });
  }, []);

  const undo = useCallback((): void => {
    // Guard on the current stack before dispatching, so a no-op undo (empty past) does not clear a standing
    // "Saved."/conflict status or spin a redundant re-render.
    const { frames: current, activeIndex: depth } = sessionRef.current;
    if (!frameCanUndo(current[depth])) return;
    dispatch({ type: "undo" });
  }, []);

  const redo = useCallback((): void => {
    const { frames: current, activeIndex: depth } = sessionRef.current;
    if (!frameCanRedo(current[depth])) return;
    dispatch({ type: "redo" });
  }, []);

  const reloadActive = useCallback((): void => {
    const plugins = pluginsRef.current;
    const { frames: current, activeIndex: depth } = sessionRef.current;
    const active = current[depth];
    // An unwritten buffer (a from-scratch root, or a create-new child) has no on-disk bytes to re-fetch —
    // reload is a no-op for it, and would discard the authored buffer for a 404.
    if (!plugins || !active || !active.written || active.path === null) return;
    const { path } = active;
    dispatch({ type: "reloadLoading", depth, path });
    runLoad(path, depth);
  }, [runLoad]);

  /**
   * The one **persist-and-advance-the-save-point** spine behind `save` and `saveNewFile` (ADR 0016, ADR
   * 0030): set the transient `saving` phase, `PUT` the buffer, and on success dispatch the caller's success
   * action carrying the fresh ETag and the canonical bytes just written. The reducer runs the guarded
   * save-point advance atomically with the `saved` phase, so a save's frame and phase never tear. Each caller
   * `.catch`es the rejection and maps a `412` to its own outcome, so this spine never swallows a failure.
   */
  const commitSave = useCallback(
    (args: {
      path: string;
      file: WorkflowFile;
      ifMatch: string | undefined;
      successAction: (result: PutResult, savedBytes: string) => SessionAction;
    }): Promise<PutResult> => {
      dispatch({ type: "saveStarted" });
      return client
        // The whole authored model, ids and all — the server preserves every `id` it is sent (ADR 0015).
        .putWorkflow({ workflowPath: args.path, workflow: args.file as unknown as JsonValue, ifMatch: args.ifMatch })
        .then((result) => {
          // `savedBytes` is the canonical serialization of the exact buffer the server wrote and hashed; the
          // buffer is clean iff it still equals it, so an author who edited *during* the in-flight save stays
          // dirty against the new baseline, which is correct.
          const savedBytes = canonicalSerialize(args.file);
          dispatch(args.successAction(result, savedBytes));
          return result;
        });
    },
    [client],
  );

  const save = useCallback((): void => {
    const { frames: current, activeIndex: depth } = sessionRef.current;
    const active = current[depth];
    const opened = openedResultOf(active);
    // A from-scratch **root** (no path) picks its path in the first-save dialog, which calls `saveNewFile`; it
    // never reaches this door. Every other active frame saves here — an overwrite for a written file, an
    // exclusive create at the pre-assigned path for an unwritten create-new child (#391).
    if (!active || !opened || active.path === null) return;
    const { path, written } = active;
    void commitSave({
      path,
      file: opened.file,
      // A written file overwrites under its `If-Match` ETag; an unwritten child creates exclusively (no
      // precondition, ADR 0016), so the server refuses an existing path rather than clobbering it.
      ifMatch: written ? (active.etag ?? undefined) : undefined,
      successAction: (result, savedBytes) => ({ type: "saved", depth, path, etag: result.etag, savedBytes }),
    }).catch((error: unknown) => {
      if (error instanceof PathApiError && error.status === 412) {
        // A `412` on a written file's overwrite is the stale-write conflict (someone else wrote it). On an
        // unwritten child's exclusive create it means the path already exists — a create collision, not a
        // stale write, so it is an error the author resolves by retargeting, not by reloading.
        dispatch({
          type: "setSaveState",
          saveState: written
            ? { phase: "conflict", message: error.message }
            : { phase: "error", message: `A workflow already exists at ${path}. Choose a different target for the reference.` },
        });
      } else {
        dispatch({ type: "setSaveState", saveState: { phase: "error", message: errorMessage(error) } });
      }
    });
  }, [commitSave]);

  const saveNewFile = useCallback(
    (targetPath: string): Promise<SaveNewFileResult> => {
      const { frames: current, activeIndex: depth } = sessionRef.current;
      const active = current[depth];
      const opened = openedResultOf(active);
      // Only a from-scratch **root** buffer (unwritten, no path) picks its path here; a create-new child
      // (unwritten, path pre-assigned) and a saved frame both go through `save`.
      if (!active || !opened || active.written || active.path !== null) {
        return Promise.resolve({ status: "error", message: "No new-file buffer to save." });
      }
      // Exclusive create (ADR 0016): no `If-Match`, so the server refuses an existing path with a `412` rather
      // than overwriting another workflow. The server echoes the resolved `relative_path`, which the frame
      // adopts as its path — placement decided at this first save, and the parent ref back-filled from it.
      return commitSave({
        path: targetPath,
        file: opened.file,
        ifMatch: undefined,
        successAction: (result, savedBytes) => ({ type: "newFileSaved", depth, etag: result.etag, savedBytes, relativePath: result.relativePath }),
      })
        .then((result): SaveNewFileResult => ({ status: "created", path: result.relativePath }))
        .catch((error: unknown): SaveNewFileResult => {
          // A `412` on a no-precondition create means the path already exists — the dialog's "choose another
          // name", not the stale-write conflict `save` shows. Drop the transient saving phase back to idle:
          // the collision is the dialog's to surface, not the toolbar's.
          if (error instanceof PathApiError && error.status === 412) {
            dispatch({ type: "setSaveState", saveState: IDLE });
            return { status: "exists" };
          }
          const message = errorMessage(error);
          dispatch({ type: "setSaveState", saveState: { phase: "error", message } });
          return { status: "error", message };
        });
    },
    [commitSave],
  );

  // Open the initial deep-link once the registry is ready. Guarded so it fires once, not on every registry
  // re-render.
  const openedInitial = useRef(false);
  useEffect(() => {
    if (registry.phase === "ready" && initialPath && !openedInitial.current) {
      openedInitial.current = true;
      open(initialPath);
    }
  }, [registry, initialPath, open]);

  return { registry, frames, activeIndex, open, newFile, descend, descendNewUnbound, goTo, applyEdit, undo, redo, save, saveNewFile, reloadActive, saveState };
}
