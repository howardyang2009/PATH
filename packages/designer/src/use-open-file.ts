import type { PathApiClient, WireStepPlugin } from "@path/client-core";
import { instantiateWorkflow, type WorkflowFile } from "@path/schema";
import { errorMessage } from "@path/viewer";
import { useCallback, useEffect, useRef, useState } from "react";
import { type DocumentWrite, loadDocument, writeDocument } from "./document.js";
import type { EditCommit, EditKey } from "./edit-key.js";
import { canonicalSerialize } from "./serialize.js";
import {
  type EditMode,
  type Frame,
  IDLE,
  initialSessionState,
  planDelete,
  planNewFileSave,
  planNewTemplateSave,
  planSave,
  planTemplateSaveAs,
  planWorkflowSaveAs,
  reduceSession,
  type SaveState,
  type SessionAction,
  type SessionState,
  stemName,
  type TemplateSource,
} from "./session-reducer.js";

export type {
  EditMode,
  Frame,
  FrameState,
  History,
  OpenedResult,
  SaveState,
  SessionAction,
  SessionState,
  TemplateSource,
} from "./session-reducer.js";
// The session state and its transitions live in `session-reducer.ts` — a pure `(state, action) => state`
// testable with no React. This hook is the thin adapter around it; the re-exports keep the split invisible.
export {
  frameCanRedo,
  frameCanUndo,
  frameDirty,
  frameHasUnsavedWork,
  openedResultOf,
  planDelete,
} from "./session-reducer.js";

/**
 * The Designer's open-and-navigate session: fetch the step-plugin registry once, open files against it,
 * and track a navigation stack of frames as a `workflow`-ref descent crosses each boundary. The stack is
 * a trail, not a tree parent — a ref'd file can have several parents. Rich state (trail, undo history,
 * save-point advance) is the reducer's; a stale completion is dropped by a monotonic token before it
 * dispatches, and by the reducer's own depth+path re-check after.
 */

/** The registry fetch state — the received `GET /v0/step-plugins` snapshot the open passes are relative to. */
export type RegistryLoad =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; plugins: WireStepPlugin[] };

/**
 * One **Save as…** of the active buffer — every door that writes it to a document it does not yet have.
 * A workflow copy mints fresh workflow and node ids via Instantiation (ADR 0006); a new template is a
 * new identity (ADR 0049 decision 8) with only its `id` minted, since Instantiation re-stamps node ids;
 * `workflow-as-template` (ADR 0063) leaves the workflow open and unchanged.
 */
export type SaveAsIntent =
  | { kind: "new-file"; path: string }
  | { kind: "workflow-copy"; path: string }
  | { kind: "new-template"; name: string; description: string }
  | { kind: "template-copy"; name: string; description: string }
  | { kind: "workflow-as-template"; name: string; description: string };

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
  /** The navigation trail, root first; the active frame is `frames[activeIndex]`, **not** the tip. */
  frames: Frame[];
  /** The index of the active frame in `frames` — what the canvas renders and every edit/save op targets. */
  activeIndex: number;
  /** Open `path` as a fresh root, discarding any current stack. */
  open: (path: string) => void;
  /** Open a `*.step-template.json` in **author mode** as a fresh root; the frame's Save writes back to it. */
  openTemplate: (template: TemplateSource) => void;
  /** Start a **from-scratch** buffer as a fresh root: no path, no lease, dirty from open. */
  newFile: () => void;
  mode: EditMode;
  /** Switch the edit mode, discarding any current stack. The canvas is empty in the new mode. */
  switchMode: (mode: EditMode) => void;
  /** Start a new, unsaved template in template mode, discarding any current stack. */
  newTemplate: () => void;
  /** Descend across the active file's `workflow`-ref; a frame ahead already holding that target is reused. */
  descend: (ref: string, nodeId: string) => void;
  /**
   * Descend into a fresh, unwritten, path-less child linked to `parentNodeId`; its first save back-fills the parent's
   * `ref`.
   */
  descendNewUnbound: (parentNodeId: string) => void;
  /** Make the breadcrumb entry at `index` active — an ascend or a forward re-entry; no frame is discarded. */
  goTo: (index: number) => void;
  /**
   * Commit an edit, re-deriving dirtiness; a field edit's `EditKey` folds a keystroke run to one entry. Any edit
   * clears redo.
   */
  applyEdit: EditCommit<WorkflowFile>;
  /** Undo the active frame's last edit, re-deriving clean. A no-op when its past stack is empty. */
  undo: () => void;
  /** Redo the active frame's last undo, re-deriving clean. A no-op when its future stack is empty. */
  redo: () => void;
  /** Save the active buffer under its `If-Match` ETag (ADR 0016); a `412` becomes a `conflict` to resolve. */
  save: () => void;
  /** Write the active buffer to a document it does not yet have; `workflow-as-template` leaves the workflow open. */
  saveAs: (intent: SaveAsIntent) => Promise<SaveAsResult>;
  /** Re-fetch the active frame from disk, discarding its unsaved buffer — the stale-write recovery. */
  reloadActive: () => void;
  /**
   * Delete the root file (`planDelete`): a workflow under its read's `If-Match` with this session's lease, or a
   * template by id.
   */
  deleteActive: (sessionId: string) => void;
  /** The active frame's save state — drives the save button and the stale-write conflict banner. */
  saveState: SaveState;
}

/**
 * The frame a just-applied loading action put in flight, when it is the one this request is for: the
 * reducer's verdict read back as I/O intent. A `descend` that re-entered the frame ahead leaves no frame
 * awaiting `seq`, so there is nothing to fetch. Module scope, so naming it never invalidates a caller.
 */
function pendingFetch(state: SessionState, seq: number): { frame: Frame; depth: number } | null {
  const depth = state.activeIndex;
  const frame = state.frames[depth];
  return frame && frame.loadSeq === seq ? { frame, depth } : null;
}

export function useOpenFile(client: PathApiClient, initialPath?: string): OpenSession {
  const [registry, setRegistry] = useState<RegistryLoad>({ phase: "loading" });
  const [session, setSession] = useState<SessionState>(initialSessionState);
  const { frames, activeIndex, saveState } = session;

  // The current session state, readable synchronously by `apply` and by the I/O callbacks. It advances
  // with the dispatch rather than a render later, so two actions in one tick cannot read a stale trail.
  const sessionRef = useRef(session);
  // The registry plugins, so an open callback reads them without waiting on a state read.
  const pluginsRef = useRef<WireStepPlugin[] | null>(null);

  /** Apply one session action and return the state it produced, so the hook reads the reducer's verdict directly. */
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

  /** Fetch the frame at `depth`, which the reducer has just put into its loading state. */
  const fetchFrame = useCallback(
    (frame: Frame, depth: number, seq: number): void => {
      const plugins = pluginsRef.current;
      if (!plugins) return;
      void loadDocument(client, frame, plugins).then((loaded) => {
        if (loaded) apply({ type: "loadLanded", depth, path: frame.path, loadSeq: seq, ...loaded });
      });
    },
    [apply, client],
  );

  const open = useCallback(
    (path: string): void => {
      if (!pluginsRef.current) return;
      const seq = ++loadSeq.current;
      const next = apply({ type: "openLoading", path, loadSeq: seq });
      fetchFrame(next.frames[next.activeIndex]!, next.activeIndex, seq);
    },
    [apply, fetchFrame],
  );

  const openTemplate = useCallback(
    (template: TemplateSource): void => {
      if (!pluginsRef.current) return;
      const seq = ++loadSeq.current;
      const next = apply({ type: "openTemplateLoading", template, loadSeq: seq });
      fetchFrame(next.frames[next.activeIndex]!, next.activeIndex, seq);
    },
    [apply, fetchFrame],
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
      const seq = ++loadSeq.current;
      const next = apply({ type: "descend", ref, nodeId, loadSeq: seq });
      const pending = pendingFetch(next, seq);
      if (pending) fetchFrame(pending.frame, pending.depth, seq);
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
      // Only the active index moves; no frame is discarded, so a dirty child keeps its buffer and lease.
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

  // A no-op undo/redo is the reducer's to swallow, so a standing "Saved"/conflict phase survives it.
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
    const seq = ++loadSeq.current;
    const next = apply({ type: "reload", loadSeq: seq });
    // An unwritten buffer leaves no frame awaiting this fetch, so it is never thrown away for a 404.
    const pending = pendingFetch(next, seq);
    if (pending) fetchFrame(pending.frame, pending.depth, seq);
  }, [apply, fetchFrame]);

  /**
   * The persist-and-advance-the-save-point spine behind `save` and `saveAs`: set `saving`, write, and dispatch the
   * caller's success action, so the save-point advance and the `saved` phase never tear (ADR 0016, ADR 0030).
   */
  const commitSave = useCallback(
    async (
      write: DocumentWrite,
      successAction: (
        result: { etag: string; relativePath: string; id: string },
        savedBytes: string,
      ) => SessionAction,
    ) => {
      apply({ type: "saveStarted" });
      const outcome = await writeDocument(client, write);
      // `savedBytes` is the canonical serialization of the exact buffer written; the buffer is clean iff it
      // still equals it, so an edit during the in-flight save stays dirty against the new baseline.
      if (outcome.ok) apply(successAction(outcome, canonicalSerialize(write.file)));
      return outcome;
    },
    [apply, client],
  );

  const save = useCallback((): void => {
    // The door is the reducer's choice (`planSave`): `null` for a from-scratch root, otherwise an
    // overwrite under the frame's `If-Match` ETag, an exclusive create at a create-new child's path,
    // or author mode's write-back.
    const plan = planSave(sessionRef.current);
    if (!plan) return;
    const write: DocumentWrite =
      plan.kind === "template"
        ? {
            to: "template",
            id: plan.id,
            ifMatch: plan.ifMatch,
            description: plan.template.description,
            file: plan.file,
          }
        : { to: "workflow", path: plan.path, ifMatch: plan.ifMatch, file: plan.file };
    void commitSave(write, (result, savedBytes) =>
      plan.kind === "template"
        ? { type: "templateSaved", depth: plan.depth, id: plan.id, etag: result.etag, savedBytes }
        : { type: "saved", depth: plan.depth, path: plan.path, etag: result.etag, savedBytes },
    ).then((outcome) => {
      if (outcome.ok) return;
      // A refused overwrite is the stale-write conflict the author reloads from; a create-new child's
      // refusal is a collision resolved by retargeting the reference.
      const saveState: SaveState =
        outcome.conflict === null
          ? { phase: "error", message: outcome.message }
          : plan.kind === "create"
            ? {
                phase: "error",
                message: `A workflow already exists at ${plan.path}. Choose a different target for the reference.`,
              }
            : { phase: "conflict", message: outcome.message };
      apply({ type: "setSaveState", saveState });
    });
  }, [apply, commitSave]);

  const saveAs = useCallback(
    async (intent: SaveAsIntent): Promise<SaveAsResult> => {
      const request = saveAsRequest(sessionRef.current, intent);
      if (typeof request === "string") return { status: "error", message: request };
      const outcome = await commitSave(request.write, request.successAction);
      if (outcome.ok)
        return {
          status: "created",
          path: request.write.to === "workflow" ? outcome.relativePath : null,
        };
      // A taken name is the dialog's to show, not the toolbar's: drop back to idle for it.
      if (outcome.conflict === "exists") {
        apply({ type: "setSaveState", saveState: IDLE });
        return { status: "exists" };
      }
      apply({
        type: "setSaveState",
        saveState: intent.kind === "new-file" ? { phase: "error", message: outcome.message } : IDLE,
      });
      return { status: "error", message: outcome.message };
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

/**
 * The write and success action one Save as… runs, from the reducer's plan — or the error message.
 */
function saveAsRequest(
  state: SessionState,
  intent: SaveAsIntent,
):
  | string
  | {
      write: DocumentWrite;
      successAction: (
        result: { etag: string; relativePath: string; id: string },
        savedBytes: string,
      ) => SessionAction;
    } {
  switch (intent.kind) {
    case "new-file": {
      // Only a from-scratch **root** buffer picks its path here; the server echoes the resolved
      // `relative_path`, which the frame adopts and the parent ref is back-filled from.
      const plan = planNewFileSave(state);
      if (!plan) return "No new-file buffer to save.";
      return {
        write: { to: "workflow", path: intent.path, ifMatch: undefined, file: plan.file },
        successAction: (result, savedBytes) => ({
          type: "newFileSaved",
          depth: plan.depth,
          etag: result.etag,
          savedBytes,
          relativePath: result.relativePath,
        }),
      };
    }
    case "workflow-copy": {
      const plan = planWorkflowSaveAs(state);
      if (!plan) return "No workflow to save.";
      const file: WorkflowFile = { ...instantiateWorkflow(plan.file), name: stemName(intent.path) };
      return {
        write: { to: "workflow", path: intent.path, ifMatch: undefined, file },
        successAction: (result) => ({
          type: "detachedSaved",
          depth: plan.depth,
          fromId: plan.file.id,
          file,
          relativePath: result.relativePath,
          etag: result.etag,
        }),
      };
    }
    case "workflow-as-template": {
      const plan = planWorkflowSaveAs(state);
      if (!plan) return "No workflow to save.";
      // Only the body survives; the workflow-level fields are dropped.
      const file: WorkflowFile = {
        format: plan.file.format,
        id: crypto.randomUUID(),
        name: intent.name,
        body: plan.file.body,
      };
      return {
        write: { to: "new-template", name: intent.name, description: intent.description, file },
        successAction: () => ({
          type: "setSaveState",
          saveState: { phase: "saved-as-template", name: intent.name },
        }),
      };
    }
    case "new-template":
    case "template-copy": {
      const copy = intent.kind === "template-copy" ? planTemplateSaveAs(state) : null;
      const plan = intent.kind === "template-copy" ? copy : planNewTemplateSave(state);
      if (!plan)
        return intent.kind === "new-template"
          ? "No new template to save."
          : "No template source to save.";
      const fromId = copy?.template.id ?? null;
      const file: WorkflowFile = { ...plan.file, id: crypto.randomUUID() };
      const template: TemplateSource = {
        id: file.id,
        kind: "step",
        name: intent.name,
        description: intent.description,
        readOnly: false,
      };
      return {
        write: { to: "new-template", name: intent.name, description: intent.description, file },
        successAction: (result) => ({
          type: "templateSavedAs",
          depth: plan.depth,
          fromId,
          template: { ...template, id: result.id },
          file,
          etag: result.etag,
        }),
      };
    }
  }
}
