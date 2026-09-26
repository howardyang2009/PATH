import { useCallback, useEffect, useRef, useState } from "react";
import type { PathApiClient, WireStepPlugin } from "@path/client-core";
import { instantiateWorkflow, type WorkflowFile } from "@path/schema";
import { loadDocument, writeDocument, type DocumentWrite } from "./document.js";
import type { EditCommit, EditKey } from "./edit-key.js";
import { canonicalSerialize } from "./serialize.js";
import {
  initialSessionState,
  planDelete,
  planNewFileSave,
  planSave,
  planNewTemplateSave,
  planTemplateSaveAs,
  planWorkflowSaveAs,
  reduceSession,
  stemName,
  type EditMode,
  type Frame,
  type SaveState,
  type SessionAction,
  type SessionState,
  type TemplateSource,
} from "./session-reducer.js";

// The session state and its transitions live in `session-reducer.ts` — a pure `(state, action) => state`
// testable with no React and no stub server. This hook is the thin adapter: it fetches the step-plugin
// registry, asks the reducer what an action decides (via `apply`'s returned state), performs the
// `client` I/O that decision calls for, and dispatches the outcome as an action. Re-export the frame
// types and predicates so the reducer's split stays invisible to the pane, the canvas, the toolbar, and
// the tests that import them from here.
export { planDelete, openedResultOf, frameDirty, frameHasUnsavedWork, frameCanUndo, frameCanRedo } from "./session-reducer.js";
export type { EditMode, Frame, FrameState, History, SaveState, OpenedResult, SessionState, SessionAction, TemplateSource } from "./session-reducer.js";

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
 * One **Save as…** of the active buffer — every door that writes the buffer to a document it does not
 * yet have:
 *
 * - `new-file` — a from-scratch workflow's first save at `path` (#390);
 * - `workflow-copy` — workflow mode's copy to a new `*.workflow.json` at `path`: Instantiation gives it a
 *   fresh workflow id and fresh node ids (ADR 0006), and its `name` is the new file's stem;
 * - `new-template` — a new template's first save (template mode);
 * - `template-copy` — author mode's copy of the opened template (#580);
 * - `workflow-as-template` — a new user template from the active workflow's body (#459.6, ADR 0063); the
 *   workflow stays open and unchanged.
 *
 * A new template is a new identity (ADR 0049 decision 8): only its `id` is minted; node ids stay, since
 * Instantiation re-stamps them on use.
 */
export type SaveAsIntent =
  | { kind: "new-file"; path: string }
  | { kind: "workflow-copy"; path: string }
  | { kind: "new-template"; name: string; description: string }
  | { kind: "template-copy"; name: string; description: string }
  | { kind: "workflow-as-template"; name: string; description: string };

/**
 * The outcome of a Save as…: `created` (with the written path, `null` for a template), `exists` — the
 * target is taken, the dialog's "choose another name", never a silent overwrite — or `error`.
 */
export type SaveAsResult =
  | { status: "created"; path: string | null }
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
   * Open a `*.step-template.json` itself as a fresh root in **author mode**
   * (#580), discarding any current stack. It reads `GET /v0/templates/:id`; the frame's Save then writes
   * back to that template.
   */
  openTemplate: (template: TemplateSource) => void;
  /**
   * Start a **from-scratch** buffer as a fresh root, discarding any current stack (#390). The frame holds
   * **no path and no lease**: an empty, editable workflow whose placement is decided at its first
   * `saveNewFile`. Reads dirty from open, so Save is live at once.
   */
  newFile: () => void;
  /** The edit mode (Workflow | Template). */
  mode: EditMode;
  /** Switch the edit mode, discarding any current stack. The canvas is empty in the new mode. */
  switchMode: (mode: EditMode) => void;
  /** Start a new, unsaved template in template mode, discarding any current stack. */
  newTemplate: () => void;
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
   * Write the active buffer to a document it does not yet have (`SaveAsIntent`). On `created` the session
   * edits the written document, except `workflow-as-template`, which leaves the workflow open.
   */
  saveAs: (intent: SaveAsIntent) => Promise<SaveAsResult>;
  /**
   * Re-fetch the active frame from disk, discarding its unsaved buffer for the on-disk bytes and a fresh
   * ETag. The stale-write recovery (#371). A no-op with no file open.
   */
  reloadActive: () => void;
  /**
   * Delete the root file from disk (`planDelete`): a workflow under its read's `If-Match`, naming this
   * session's edit lease `sessionId` so the server removes it with the file, or a user template by id. On
   * success the canvas is empty in the `deleted` phase; a refusal is the `delete-error` phase. A no-op when
   * there is nothing to delete.
   */
  deleteActive: (sessionId: string) => void;
  /** The active frame's save state — drives the save button and the stale-write conflict banner. */
  saveState: SaveState;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

  /**
   * Fetch the frame at `depth`, which the reducer has just put into its loading state: a workflow file by
   * its path, or an author-mode template source by its id.
   */
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

  /**
   * The frame a just-applied loading action put in flight, when it is the one this request is for. The
   * reducer's verdict read back as I/O intent: a `descend` that re-entered the frame ahead (or a `reload`
   * that decided nothing was reloadable) leaves no frame awaiting `seq`, so there is nothing to fetch.
   */
  const pendingFetch = (state: SessionState, seq: number): { frame: Frame; depth: number } | null => {
    const depth = state.activeIndex;
    const frame = state.frames[depth];
    return frame && frame.loadSeq === seq ? { frame, depth } : null;
  };

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
    // A from-scratch buffer fetches nothing, and its frame holds no fetch number, so any in-flight load
    // is dropped by the reducer rather than landing in the discarded stack.
    apply({ type: "newFile" });
  }, [apply]);

  const switchMode = useCallback((mode: EditMode): void => {
    apply({ type: "switchMode", mode });
  }, [apply]);

  const newTemplate = useCallback((): void => {
    apply({ type: "newTemplate" });
  }, [apply]);

  const descend = useCallback(
    (ref: string, nodeId: string): void => {
      // A descent crosses a `workflow`-ref of the active file, so a file must be open and the registry
      // ready to parse what comes back; the reducer no-ops for a from-scratch frame with no path.
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
  // "Saved"/conflict phase survives one without the hook pre-checking the stack.
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
        .catch((error: unknown) => apply({ type: "setSaveState", saveState: { phase: "delete-error", message: errorMessage(error) } }));
    },
    [apply, client],
  );

  const reloadActive = useCallback((): void => {
    if (!pluginsRef.current) return;
    const seq = ++loadSeq.current;
    const next = apply({ type: "reload", loadSeq: seq });
    // The reducer decided whether anything was reloadable: an unwritten buffer leaves no frame awaiting
    // this fetch, so the authored buffer is never thrown away for a 404.
    const pending = pendingFetch(next, seq);
    if (pending) fetchFrame(pending.frame, pending.depth, seq);
  }, [apply, fetchFrame]);

  /**
   * The one **persist-and-advance-the-save-point** spine behind `save` and `saveAs` (ADR 0016, ADR 0030):
   * set the transient `saving` phase, write the document, and on success dispatch the caller's success
   * action carrying the write's echo and the canonical bytes just written. The reducer runs the guarded
   * save-point advance atomically with the `saved` phase, so a save's frame and phase never tear. A refusal
   * is returned for the caller to map; the spine leaves the `saving` phase for it to replace.
   */
  const commitSave = useCallback(
    async (write: DocumentWrite, successAction: (result: { etag: string; relativePath: string; id: string }, savedBytes: string) => SessionAction) => {
      apply({ type: "saveStarted" });
      const outcome = await writeDocument(client, write);
      // `savedBytes` is the canonical serialization of the exact buffer the server wrote and hashed; the
      // buffer is clean iff it still equals it, so an author who edited *during* the in-flight save stays
      // dirty against the new baseline, which is correct.
      if (outcome.ok) apply(successAction(outcome, canonicalSerialize(write.file)));
      return outcome;
    },
    [apply, client],
  );

  const save = useCallback((): void => {
    // The door is the reducer's choice (`planSave`): `null` for a from-scratch root, which picks its path
    // in the first-save dialog instead, and otherwise an overwrite under the frame's `If-Match` ETag, an
    // exclusive create at a create-new child's pre-assigned path (ADR 0016), or author mode's write-back to
    // the original template by id (#580).
    const plan = planSave(sessionRef.current);
    if (!plan) return;
    const write: DocumentWrite =
      plan.kind === "template"
        ? { to: "template", id: plan.id, ifMatch: plan.ifMatch, description: plan.template.description, file: plan.file }
        : { to: "workflow", path: plan.path, ifMatch: plan.ifMatch, file: plan.file };
    void commitSave(write, (result, savedBytes) =>
      plan.kind === "template"
        ? { type: "templateSaved", depth: plan.depth, id: plan.id, etag: result.etag, savedBytes }
        : { type: "saved", depth: plan.depth, path: plan.path, etag: result.etag, savedBytes },
    ).then((outcome) => {
      if (outcome.ok) return;
      // A refused overwrite is the stale-write conflict the author reloads from. A create-new child's
      // refusal is a create collision the author resolves by retargeting the reference, not by reloading.
      // Which one this is is the plan's own `kind`. A shipped template's `403` is the API's refusal, shown
      // as the save error it is.
      const saveState: SaveState =
        outcome.conflict === null
          ? { phase: "error", message: outcome.message }
          : plan.kind === "create"
            ? { phase: "error", message: `A workflow already exists at ${plan.path}. Choose a different target for the reference.` }
            : { phase: "conflict", message: outcome.message };
      apply({ type: "setSaveState", saveState });
    });
  }, [apply, commitSave]);

  const saveAs = useCallback(
    async (intent: SaveAsIntent): Promise<SaveAsResult> => {
      const request = saveAsRequest(sessionRef.current, intent);
      if (typeof request === "string") return { status: "error", message: request };
      const outcome = await commitSave(request.write, request.successAction);
      if (outcome.ok) return { status: "created", path: request.write.to === "workflow" ? outcome.relativePath : null };
      // A taken name is the dialog's to show, not the toolbar's: drop the transient saving phase back to
      // idle for it. Any other refusal is the save error it is.
      if (outcome.conflict === "exists") {
        apply({ type: "setSaveState", saveState: IDLE });
        return { status: "exists" };
      }
      apply({ type: "setSaveState", saveState: intent.kind === "new-file" ? { phase: "error", message: outcome.message } : IDLE });
      return { status: "error", message: outcome.message };
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

  return { registry, mode: session.mode, switchMode, newTemplate, frames, activeIndex, open, openTemplate, newFile, descend, descendNewUnbound, goTo, applyEdit, undo, redo, save, saveAs, reloadActive, deleteActive, saveState };
}

/**
 * The write and the success action one Save as… runs, from the reducer's plan for it — or the error
 * message when the active frame is not a buffer that intent can save.
 */
function saveAsRequest(
  state: SessionState,
  intent: SaveAsIntent,
): string | { write: DocumentWrite; successAction: (result: { etag: string; relativePath: string; id: string }, savedBytes: string) => SessionAction } {
  switch (intent.kind) {
    case "new-file": {
      // Only a from-scratch **root** buffer (unwritten, no path) picks its path here; a create-new child and
      // a saved frame both go through `save`. The server echoes the resolved `relative_path`, which the frame
      // adopts as its path — placement decided at this first save, and the parent ref back-filled from it.
      const plan = planNewFileSave(state);
      if (!plan) return "No new-file buffer to save.";
      return {
        write: { to: "workflow", path: intent.path, ifMatch: undefined, file: plan.file },
        successAction: (result, savedBytes) => ({ type: "newFileSaved", depth: plan.depth, etag: result.etag, savedBytes, relativePath: result.relativePath }),
      };
    }
    case "workflow-copy": {
      const plan = planWorkflowSaveAs(state);
      if (!plan) return "No workflow to save.";
      const file: WorkflowFile = { ...instantiateWorkflow(plan.file), name: stemName(intent.path) };
      return {
        write: { to: "workflow", path: intent.path, ifMatch: undefined, file },
        successAction: (result) => ({ type: "detachedSaved", depth: plan.depth, fromId: plan.file.id, file, relativePath: result.relativePath, etag: result.etag }),
      };
    }
    case "workflow-as-template": {
      const plan = planWorkflowSaveAs(state);
      if (!plan) return "No workflow to save.";
      // Only the body survives; the workflow-level fields are dropped.
      const file: WorkflowFile = { format: plan.file.format, id: crypto.randomUUID(), name: intent.name, body: plan.file.body };
      return {
        write: { to: "new-template", name: intent.name, description: intent.description, file },
        successAction: () => ({ type: "setSaveState", saveState: { phase: "saved-as-template", name: intent.name } }),
      };
    }
    case "new-template":
    case "template-copy": {
      const copy = intent.kind === "template-copy" ? planTemplateSaveAs(state) : null;
      const plan = intent.kind === "template-copy" ? copy : planNewTemplateSave(state);
      if (!plan) return intent.kind === "new-template" ? "No new template to save." : "No template source to save.";
      const fromId = copy?.template.id ?? null;
      const file: WorkflowFile = { ...plan.file, id: crypto.randomUUID() };
      const template: TemplateSource = { id: file.id, kind: "step", name: intent.name, description: intent.description, readOnly: false };
      return {
        write: { to: "new-template", name: intent.name, description: intent.description, file },
        successAction: (result) => ({ type: "templateSavedAs", depth: plan.depth, fromId, template: { ...template, id: result.id }, file, etag: result.etag }),
      };
    }
  }
}
