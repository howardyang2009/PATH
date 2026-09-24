import { useCallback, useEffect, useRef, useState } from "react";
import { PathApiError, type JsonValue, type PathApiClient, type WireStepPlugin } from "@path/client-core";
import type { WorkflowFile } from "@path/schema";
import type { EditCommit, EditKey } from "./edit-key.js";
import { openWorkflowFile } from "./open-workflow.js";
import { canonicalSerialize } from "./serialize.js";
import {
  canvasEmpty,
  initialSessionState,
  planNewFileSave,
  planSave,
  reduceSession,
  type Frame,
  type SaveState,
  type SessionAction,
  type SessionState,
} from "./session-reducer.js";

// The session state and its transitions live in `session-reducer.ts` — a pure `(state, action) => state`
// testable with no React and no stub server. This hook is the thin adapter: it fetches the step-plugin
// registry, asks the reducer what an action decides (via `apply`'s returned state), performs the
// `client` I/O that decision calls for, and dispatches the outcome as an action. Re-export the frame
// types and predicates so the reducer's split stays invisible to the pane, the canvas, the toolbar, and
// the tests that import them from here.
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
  /** Is the canvas empty — nothing open, or an active buffer with zero nodes (#579, `canvasEmpty`)? */
  canvasEmpty: boolean;
  /**
   * Put a Workflow-Template instance on the empty canvas (#579): a from-scratch root when nothing is open,
   * else one undoable edit of the empty active buffer. Returns `false`, changing nothing, when the canvas
   * is no longer empty.
   */
  placeWorkflowInstance: (file: WorkflowFile) => boolean;
  /**
   * Descend across the active file's `workflow`-ref (a relative path), making a child frame active. If the
   * frame just ahead of the active one already holds that resolved target, it is **reused**; otherwise the
   * forward trail is truncated and the target is loaded fresh.
   */
  descend: (ref: string, nodeId: string) => void;
  /**
   * Descend into a **fresh, unwritten, path-less** child buffer for a create-new nested ref (#391), linked
   * back to the `workflow` node `parentNodeId` in the active (parent) frame. Its first save also **back-fills
   * the parent node's `ref`** from the path the child is saved to. The forward trail is truncated.
   */
  descendNewUnbound: (parentNodeId: string) => void;
  /** Make the breadcrumb entry at `index` active — an ascend or a forward re-entry; no frame is discarded. */
  goTo: (index: number) => void;
  /**
   * Commit an edit to the active frame's opened file; dirtiness re-derives (#368, ADR 0030) and an
   * undo entry is recorded (#389). A structural edit passes no identity (one entry each); a field edit
   * passes its `EditKey` so a run of keystrokes in that one field folds to a single entry. Any edit
   * clears the frame's redo stack.
   */
  applyEdit: EditCommit<WorkflowFile>;
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
  const [session, setSession] = useState<SessionState>(initialSessionState);
  const { frames, activeIndex, saveState } = session;

  // The current session state, readable synchronously by `apply` and by the I/O callbacks. It advances
  // with the dispatch rather than a render later, so two actions in one tick cannot read a stale trail.
  const sessionRef = useRef(session);
  // The registry plugins, so an open callback reads them without waiting on a state read.
  const pluginsRef = useRef<WireStepPlugin[] | null>(null);

  /**
   * Apply one session action and return the state it produced. The reducer decides; the hook reads the
   * verdict off the returned state — a `descend` that re-entered the frame ahead needs no fetch, one that
   * pushed a loading frame does — instead of working the same thing out a second time.
   */
  const apply = useCallback((action: SessionAction): SessionState => {
    const next = reduceSession(sessionRef.current, action);
    sessionRef.current = next;
    setSession(next);
    return next;
  }, []);

  // The number each fetch carries. Minted here because only the hook knows a request was made; what the
  // number *means* — a landing is stale unless the frame still awaits it — is the reducer's (`Frame.loadSeq`).
  const loadSeq = useRef(0);

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

  /** Fetch `path` into the frame at `depth`, which the reducer has just put into its loading state. */
  const fetchFrame = useCallback(
    (path: string, depth: number, seq: number): void => {
      const plugins = pluginsRef.current;
      if (!plugins) return;
      void loadFrame(client, path, plugins).then(({ frameState, etag, baseline, openedBytes }) => {
        apply({ type: "loadLanded", depth, path, loadSeq: seq, frameState, etag, baseline, openedBytes });
      });
    },
    [apply, client],
  );

  /**
   * The frame a just-applied loading action put in flight, when it is the one this request is for. The
   * reducer's verdict read back as I/O intent: a `descend` that re-entered the frame ahead (or a `reload`
   * that decided nothing was reloadable) leaves no frame awaiting `seq`, so there is nothing to fetch.
   */
  const pendingFetch = (state: SessionState, seq: number): { path: string; depth: number } | null => {
    const depth = state.activeIndex;
    const frame = state.frames[depth];
    return frame && frame.loadSeq === seq && frame.path !== null ? { path: frame.path, depth } : null;
  };

  const open = useCallback(
    (path: string): void => {
      if (!pluginsRef.current) return;
      const seq = ++loadSeq.current;
      const next = apply({ type: "openLoading", path, loadSeq: seq });
      fetchFrame(path, next.activeIndex, seq);
    },
    [apply, fetchFrame],
  );

  const newFile = useCallback((): void => {
    // A from-scratch buffer fetches nothing, and its frame holds no fetch number, so any in-flight load
    // is dropped by the reducer rather than landing in the discarded stack.
    apply({ type: "newFile" });
  }, [apply]);

  const placeWorkflowInstance = useCallback(
    (file: WorkflowFile): boolean => {
      // The reducer re-checks emptiness against the current state, so a template read that lands after
      // the author already built a body is refused rather than overwriting it.
      const before = sessionRef.current;
      return apply({ type: "placeWorkflowInstance", file }) !== before;
    },
    [apply],
  );

  const descend = useCallback(
    (ref: string, nodeId: string): void => {
      // A descent crosses a `workflow`-ref of the active file, so a file must be open and the registry
      // ready to parse what comes back; the reducer no-ops for a from-scratch frame with no path.
      if (!pluginsRef.current) return;
      const seq = ++loadSeq.current;
      const next = apply({ type: "descend", ref, nodeId, loadSeq: seq });
      const pending = pendingFetch(next, seq);
      if (pending) fetchFrame(pending.path, pending.depth, seq);
    },
    [apply, fetchFrame],
  );

  const descendNewUnbound = useCallback(
    (parentNodeId: string): void => {
      apply({ type: "descendNewUnbound", parentNodeId });
    },
    [apply],
  );

  const goTo = useCallback(
    (index: number): void => {
      // An ascend (or forward re-entry) only moves the active frame — no frame is discarded, so a dirty
      // descended child keeps its buffer and its beating lease, and a pending load stays the frame's own.
      apply({ type: "goTo", index });
    },
    [apply],
  );

  const applyEdit = useCallback(
    (next: WorkflowFile, key?: EditKey): void => {
      apply({ type: "applyEdit", next, key });
    },
    [apply],
  );

  // A no-op undo/redo is the reducer's to swallow (it returns the same state), so a standing
  // "Saved."/conflict phase survives one without the hook pre-checking the stack.
  const undo = useCallback((): void => {
    apply({ type: "undo" });
  }, [apply]);

  const redo = useCallback((): void => {
    apply({ type: "redo" });
  }, [apply]);

  const reloadActive = useCallback((): void => {
    if (!pluginsRef.current) return;
    const seq = ++loadSeq.current;
    const next = apply({ type: "reload", loadSeq: seq });
    // The reducer decided whether anything was reloadable: an unwritten buffer leaves no frame awaiting
    // this fetch, so the authored buffer is never thrown away for a 404.
    const pending = pendingFetch(next, seq);
    if (pending) fetchFrame(pending.path, pending.depth, seq);
  }, [apply, fetchFrame]);

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
      apply({ type: "saveStarted" });
      return client
        // The whole authored model, ids and all — the server preserves every `id` it is sent (ADR 0015).
        .putWorkflow({ workflowPath: args.path, workflow: args.file as unknown as JsonValue, ifMatch: args.ifMatch })
        .then((result) => {
          // `savedBytes` is the canonical serialization of the exact buffer the server wrote and hashed; the
          // buffer is clean iff it still equals it, so an author who edited *during* the in-flight save stays
          // dirty against the new baseline, which is correct.
          const savedBytes = canonicalSerialize(args.file);
          apply(args.successAction(result, savedBytes));
          return result;
        });
    },
    [apply, client],
  );

  const save = useCallback((): void => {
    // The door is the reducer's choice (`planSave`): `null` for a from-scratch root, which picks its path
    // in the first-save dialog instead, and otherwise an overwrite under the frame's `If-Match` ETag or an
    // exclusive create at a create-new child's pre-assigned path (ADR 0016).
    const plan = planSave(sessionRef.current);
    if (!plan) return;
    void commitSave({
      path: plan.path,
      file: plan.file,
      ifMatch: plan.ifMatch,
      successAction: (result, savedBytes) => ({ type: "saved", depth: plan.depth, path: plan.path, etag: result.etag, savedBytes }),
    }).catch((error: unknown) => {
      if (error instanceof PathApiError && error.status === 412) {
        // A `412` on a written file's overwrite is the stale-write conflict (someone else wrote it). On an
        // unwritten child's exclusive create it means the path already exists — a create collision, not a
        // stale write, so it is an error the author resolves by retargeting, not by reloading. Which one
        // this is is the plan's own `kind`, not a re-reading of the frame.
        apply({
          type: "setSaveState",
          saveState:
            plan.kind === "overwrite"
              ? { phase: "conflict", message: error.message }
              : { phase: "error", message: `A workflow already exists at ${plan.path}. Choose a different target for the reference.` },
        });
      } else {
        apply({ type: "setSaveState", saveState: { phase: "error", message: errorMessage(error) } });
      }
    });
  }, [apply, commitSave]);

  const saveNewFile = useCallback(
    (targetPath: string): Promise<SaveNewFileResult> => {
      // Only a from-scratch **root** buffer (unwritten, no path) picks its path here — the reducer's
      // `planNewFileSave`; a create-new child and a saved frame both go through `save`.
      const plan = planNewFileSave(sessionRef.current);
      if (!plan) return Promise.resolve({ status: "error", message: "No new-file buffer to save." });
      // Exclusive create (ADR 0016): no `If-Match`, so the server refuses an existing path with a `412` rather
      // than overwriting another workflow. The server echoes the resolved `relative_path`, which the frame
      // adopts as its path — placement decided at this first save, and the parent ref back-filled from it.
      return commitSave({
        path: targetPath,
        file: plan.file,
        ifMatch: undefined,
        successAction: (result, savedBytes) => ({ type: "newFileSaved", depth: plan.depth, etag: result.etag, savedBytes, relativePath: result.relativePath }),
      })
        .then((result): SaveNewFileResult => ({ status: "created", path: result.relativePath }))
        .catch((error: unknown): SaveNewFileResult => {
          // A `412` on a no-precondition create means the path already exists — the dialog's "choose another
          // name", not the stale-write conflict `save` shows. Drop the transient saving phase back to idle:
          // the collision is the dialog's to surface, not the toolbar's.
          if (error instanceof PathApiError && error.status === 412) {
            apply({ type: "setSaveState", saveState: IDLE });
            return { status: "exists" };
          }
          const message = errorMessage(error);
          apply({ type: "setSaveState", saveState: { phase: "error", message } });
          return { status: "error", message };
        });
    },
    [apply, commitSave],
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

  return { registry, frames, activeIndex, open, newFile, canvasEmpty: canvasEmpty(session), placeWorkflowInstance, descend, descendNewUnbound, goTo, applyEdit, undo, redo, save, saveNewFile, reloadActive, saveState };
}
