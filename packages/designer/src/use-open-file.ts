import type { PathApiClient, WireStepPlugin } from "@path/client-core";
import type { WorkflowFile } from "@path/schema";
import { errorMessage } from "@path/viewer";
import { useCallback, useEffect, useRef, useState } from "react";
import { loadDocument, writeDocument } from "./document.js";
import type { EditCommit, EditKey } from "./edit-key.js";
import { canonicalSerialize } from "./serialize.js";
import {
  type EditMode,
  type FetchRequest,
  type Frame,
  initialSessionState,
  planDelete,
  planWrite,
  reduceSession,
  type SaveAsIntent,
  type SaveState,
  type SessionAction,
  type SessionOutcome,
  type SessionState,
  type TemplateSource,
  type WritePlan,
} from "./session-reducer.js";

export type {
  EditMode,
  Frame,
  FrameState,
  History,
  OpenedResult,
  SaveAsIntent,
  SaveState,
  SessionAction,
  SessionState,
  TemplateSource,
} from "./session-reducer.js";
// The session state and its transitions live in `session-reducer.ts` — a pure `(state, action) =>
// state` testable with no React. This hook is the thin adapter around it; the re-exports keep the
// split invisible.
export {
  frameCanRedo,
  frameCanUndo,
  frameDirty,
  frameHasUnsavedWork,
  openedResultOf,
  planDelete,
} from "./session-reducer.js";

/**
 * The Designer's open-and-navigate session: fetch the step-plugin registry once, open files against
 * it, and track a navigation stack of frames as a `workflow`-ref descent crosses each boundary. The
 * stack is a trail, not a tree parent — a ref'd file can have several parents. Rich state (trail,
 * undo history, save-point advance) is the reducer's; a stale completion is dropped by a monotonic
 * token before it dispatches, and by the reducer's own depth+path re-check after.
 */

/** The registry fetch state — the received `GET /v0/step-plugins` snapshot the open passes are
 * relative to. */
export type RegistryLoad =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; plugins: WireStepPlugin[] };

/**
 * The outcome of a Save as…: `created` (path `null` for a template), `exists` — target taken, the
 * dialog's "choose another name", never a silent overwrite — or `error`.
 */
export type SaveAsResult =
  | { status: "created"; path: string | null }
  | { status: "exists" }
  | { status: "error"; message: string };

export interface OpenSession {
  registry: RegistryLoad;
  /** The navigation trail, root first; the active frame is `frames[activeIndex]`, **not** the
   * tip. */
  frames: Frame[];
  /** The index of the active frame in `frames` — what the canvas renders and every edit/save op
   * targets. */
  activeIndex: number;
  /** Open `path` as a fresh root, discarding any current stack. */
  open: (path: string) => void;
  /** Open a `*.step-template.json` in **author mode** as a fresh root; the frame's Save writes back
   * to it. */
  openTemplate: (template: TemplateSource) => void;
  /** Start a **from-scratch** buffer as a fresh root: no path, no lease, dirty from open. */
  newFile: () => void;
  mode: EditMode;
  /** Switch the edit mode, discarding any current stack. The canvas is empty in the new mode. */
  switchMode: (mode: EditMode) => void;
  /** Start a new, unsaved template in template mode, discarding any current stack. */
  newTemplate: () => void;
  /** Descend across the active file's `workflow`-ref; a frame ahead already holding that target is
   * reused. */
  descend: (ref: string, nodeId: string) => void;
  /**
   * Descend into a fresh, unwritten, path-less child linked to `parentNodeId`; its first save
   * back-fills the parent's `ref`.
   */
  descendNewUnbound: (parentNodeId: string) => void;
  /** Make the breadcrumb entry at `index` active — an ascend or a forward re-entry; no frame is
   * discarded. */
  goTo: (index: number) => void;
  /**
   * Commit an edit, re-deriving dirtiness; a field edit's `EditKey` folds a keystroke run to one
   * entry. Any edit clears redo.
   */
  applyEdit: EditCommit<WorkflowFile>;
  /** Undo the active frame's last edit, re-deriving clean. A no-op when its past stack is empty. */
  undo: () => void;
  /** Redo the active frame's last undo, re-deriving clean. A no-op when its future stack is
   * empty. */
  redo: () => void;
  /** Save the active buffer under its `If-Match` ETag (ADR 0016); a `412` becomes a `conflict` to
   * resolve. */
  save: () => void;
  /** Write the active buffer to a document it does not yet have; `workflow-as-template` leaves the
   * workflow open. */
  saveAs: (intent: SaveAsIntent) => Promise<SaveAsResult>;
  /** Re-fetch the active frame from disk, discarding its unsaved buffer — the stale-write
   * recovery. */
  reloadActive: () => void;
  /**
   * Delete the root file (`planDelete`): a workflow under its read's `If-Match` with this session's
   * lease, or a template by id.
   */
  deleteActive: (sessionId: string) => void;
  /** The active frame's save state — drives the save button and the stale-write conflict banner. */
  saveState: SaveState;
}

export function useOpenFile(client: PathApiClient, initialPath?: string): OpenSession {
  const [registry, setRegistry] = useState<RegistryLoad>({ phase: "loading" });
  const [session, setSession] = useState<SessionState>(initialSessionState);
  const { frames, activeIndex, saveState } = session;

  // The current session state, readable synchronously by `apply` and by the I/O callbacks. It
  // advances with the dispatch rather than a render later, so two actions in one tick cannot read a
  // stale trail.
  const sessionRef = useRef(session);
  // The registry plugins, so an open callback reads them without waiting on a state read.
  const pluginsRef = useRef<WireStepPlugin[] | null>(null);

  /** Apply one session action and return what it produced: the next state, and the read it asks for
   * (if any). The reducer resolves both, so the hook performs I/O and decides nothing. */
  const apply = useCallback((action: SessionAction): SessionOutcome => {
    const outcome = reduceSession(sessionRef.current, action);
    sessionRef.current = outcome.state;
    setSession(outcome.state);
    return outcome;
  }, []);

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

  /** Perform the read the reducer asked for, echoing its token back so a landing the author has
   * since outrun is dropped. */
  const fetchFrame = useCallback(
    (request: FetchRequest): void => {
      const plugins = pluginsRef.current;
      if (!plugins) return;
      const { frame, depth, token } = request;
      void loadDocument(client, frame, plugins).then((loaded) => {
        if (loaded) apply({ type: "loadLanded", depth, path: frame.path, token, ...loaded });
      });
    },
    [apply, client],
  );

  /** Apply an action and run whatever read it asked for — the whole shape of an I/O step. */
  const applyAndFetch = useCallback(
    (action: SessionAction): void => {
      const { fetch } = apply(action);
      if (fetch) fetchFrame(fetch);
    },
    [apply, fetchFrame],
  );

  const open = useCallback(
    (path: string): void => {
      if (!pluginsRef.current) return;
      applyAndFetch({ type: "openLoading", path });
    },
    [applyAndFetch],
  );

  const openTemplate = useCallback(
    (template: TemplateSource): void => {
      if (!pluginsRef.current) return;
      applyAndFetch({ type: "openTemplateLoading", template });
    },
    [applyAndFetch],
  );

  const newFile = useCallback((): void => {
    // A from-scratch buffer fetches nothing, so any in-flight load is dropped by the reducer.
    apply({ type: "newFile" });
  }, [apply]);

  const switchMode = useCallback(
    (mode: EditMode): void => {
      apply({ type: "switchMode", mode });
    },
    [apply],
  );

  const newTemplate = useCallback((): void => {
    apply({ type: "newTemplate" });
  }, [apply]);

  const descend = useCallback(
    (ref: string, nodeId: string): void => {
      // A descent needs a file open and the registry ready to parse what comes back.
      if (!pluginsRef.current) return;
      // Re-entering the frame ahead asks for no read; the reducer's outcome says so.
      applyAndFetch({ type: "descend", ref, nodeId });
    },
    [applyAndFetch],
  );

  const descendNewUnbound = useCallback(
    (parentNodeId: string): void => {
      apply({ type: "descendNewUnbound", parentNodeId });
    },
    [apply],
  );

  const goTo = useCallback(
    (index: number): void => {
      // Only the active index moves; no frame is discarded, so a dirty child keeps its buffer and
      // lease.
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

  // A no-op undo/redo is the reducer's to swallow, so a standing "Saved"/conflict phase survives
  // it.
  const undo = useCallback((): void => {
    apply({ type: "undo" });
  }, [apply]);

  const redo = useCallback((): void => {
    apply({ type: "redo" });
  }, [apply]);

  const deleteActive = useCallback(
    (sessionId: string): void => {
      const plan = planDelete(sessionRef.current);
      if (!plan) return;
      apply({ type: "setSaveState", saveState: { phase: "deleting" } });
      const request =
        plan.kind === "template"
          ? client.deleteTemplate(plan.id)
          : client.deleteWorkflowFile({ path: plan.path, ifMatch: plan.ifMatch, sessionId });
      request
        .then(() => apply({ type: "deleted", plan }))
        .catch((error: unknown) =>
          apply({
            type: "setSaveState",
            saveState: { phase: "delete-error", message: errorMessage(error) },
          }),
        );
    },
    [apply, client],
  );

  const reloadActive = useCallback((): void => {
    if (!pluginsRef.current) return;
    // An unwritten buffer asks for no read, so it is never thrown away for a 404.
    applyAndFetch({ type: "reload" });
  }, [applyAndFetch]);

  /**
   * The persist-and-advance-the-save-point spine behind `save` and `saveAs`: set `saving`, write
   * the plan, and dispatch the action the plan lands, so the save-point advance and the `saved`
   * phase never tear (ADR 0016, ADR 0030).
   */
  const commitSave = useCallback(
    async (plan: WritePlan) => {
      apply({ type: "saveStarted" });
      const outcome = await writeDocument(client, plan.write);
      // `savedBytes` is the canonical serialization of the exact buffer written; the buffer is
      // clean iff it still equals it, so an edit during the in-flight save stays dirty against the
      // new baseline.
      if (outcome.ok) apply(plan.landed(outcome, canonicalSerialize(plan.write.file)));
      return outcome;
    },
    [apply, client],
  );

  const save = useCallback((): void => {
    const plan = planWrite(sessionRef.current, { kind: "save" });
    // No plan: nothing is open, or the buffer has no identity yet and a dialog owns its first save.
    if (!plan.ok) return;
    void commitSave(plan).then((outcome) => {
      if (!outcome.ok) apply({ type: "setSaveState", saveState: plan.refused(outcome) });
    });
  }, [apply, commitSave]);

  const saveAs = useCallback(
    async (intent: SaveAsIntent): Promise<SaveAsResult> => {
      const plan = planWrite(sessionRef.current, intent);
      if (!plan.ok) return { status: "error", message: plan.message };
      const outcome = await commitSave(plan);
      if (outcome.ok)
        return {
          status: "created",
          path: plan.write.to === "workflow" ? outcome.relativePath : null,
        };
      apply({ type: "setSaveState", saveState: plan.refused(outcome) });
      // A taken name is the dialog's to show: its own "choose another" result, not a message.
      return outcome.conflict === "exists"
        ? { status: "exists" }
        : { status: "error", message: outcome.message };
    },
    [apply, commitSave],
  );

  // Open the initial deep-link once the registry is ready (guarded so it fires once).
  const openedInitial = useRef(false);
  useEffect(() => {
    if (registry.phase === "ready" && initialPath && !openedInitial.current) {
      openedInitial.current = true;
      open(initialPath);
    }
  }, [registry, initialPath, open]);

  return {
    registry,
    mode: session.mode,
    switchMode,
    newTemplate,
    frames,
    activeIndex,
    open,
    openTemplate,
    newFile,
    descend,
    descendNewUnbound,
    goTo,
    applyEdit,
    undo,
    redo,
    save,
    saveAs,
    reloadActive,
    deleteActive,
    saveState,
  };
}
