import { useCallback, useEffect, useRef, useState } from "react";
import { PathApiError, type JsonValue, type PathApiClient, type WireStepPlugin } from "@path/client-core";
import { FORMAT_VERSION, instantiateWorkflow, type WorkflowFile, type WorkflowNode } from "@path/schema";
import type { EditCommit, EditKey } from "./edit-key.js";
import { openWorkflowFile } from "./open-workflow.js";
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
 * The outcome of a from-scratch buffer's first save (#390, designer-spec § New-file placement and naming). A
 * new-file save is an **exclusive create** (no `If-Match`, ADR 0016): the server refuses an existing path
 * with a `412`, which reads here as `exists` — the dialog's "choose another name", never a silent overwrite.
 * `created` reports the path the server echoed; the frame is now saved. `error` is any other failure.
 */
export type SaveNewFileResult =
  | { status: "created"; path: string }
  | { status: "exists" }
  | { status: "error"; message: string };

/**
 * The outcome of an author-mode **Save as template** (#580): `created` names the new template, `exists`
 * is the `409` "that name is taken", and `error` is any other failure (a bad name is a `400`).
 */
export type SaveAsTemplateResult =
  | { status: "created"; name: string }
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
   * Workflow mode's **Save as…**: write a copy of the active buffer to a new `*.workflow.json` at
   * `targetPath` as an exclusive create. The copy is a new workflow: Instantiation gives it a fresh
   * workflow id and fresh node ids (two workflows must not share identity, ADR 0006), and its `name` is
   * the new file's stem. On `created` the session edits the new file; the original file is unchanged.
   */
  saveWorkflowAs: (targetPath: string) => Promise<SaveNewFileResult>;
  /**
   * Workflow mode's **Save as template** (#459.6, ADR 0063): create a new user template named
   * `name` from the active workflow's body through `POST /v0/templates`, with a fresh `id` (a template
   * must not share the workflow's identity). Only the body is kept; the workflow-level fields are dropped.
   * The workflow stays open and unchanged; the phase becomes `saved-as-template`.
   */
  saveWorkflowAsTemplate: (name: string, description: string) => Promise<SaveAsTemplateResult>;
  /**
   * First-save a new template (template mode): create it through `POST /v0/templates`, with a fresh
   * id. On `created` the frame edits the new template.
   */
  saveNewTemplate: (name: string, description: string) => Promise<SaveAsTemplateResult>;
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
   * Author mode's **Save as…** (#580): create a new user template named `name` through
   * `POST /v0/templates`, with a fresh `id` (two templates must not share identity). On `created` the frame
   * edits the new template. An `error` when the
   * active frame is not a template source.
   */
  saveAsTemplate: (name: string, description: string) => Promise<SaveAsTemplateResult>;
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

/**
 * Read a template source (`GET /v0/templates/:id`) and run the open pipeline over it (#580). Its
 * `body` is a node list, so it opens inside a synthetic workflow file that carries the template's id and
 * name (an invalid one still reads, so the refusal names why). The envelope carries
 * no raw bytes, so the baseline is the canonical serialization of the opened file. A file the open parse
 * re-orders therefore opens dirty, as a hand-authored workflow does (ADR 0030).
 */
async function loadTemplateFrame(
  client: PathApiClient,
  template: TemplateSource,
  plugins: WireStepPlugin[],
): Promise<{ frameState: Frame["state"]; etag: string | null; baseline: string; openedBytes: string }> {
  try {
    const envelope = await client.getTemplate(template.id);
    if (envelope.kind !== template.kind) throw new Error(`"${envelope.name}" is not a ${template.kind}-template`);
    const file: WorkflowFile = { format: FORMAT_VERSION, id: envelope.id, name: envelope.name, body: envelope.body as WorkflowNode[] };
    const text = canonicalSerialize(file);
    const result = openWorkflowFile(text, plugins);
    const openedBytes = result.status === "opened" ? canonicalSerialize(result.file) : "";
    return { frameState: { phase: "open", result }, etag: envelope.etag, baseline: text, openedBytes };
  } catch (error) {
    return { frameState: { phase: "fetch-error", message: errorMessage(error) }, etag: null, baseline: "", openedBytes: "" };
  }
}

/** The template object a template write sends: a template envelope around the buffer's body (ADR 0048). */
function templateBody(template: TemplateSource, file: WorkflowFile): Record<string, unknown> {
  return { format: FORMAT_VERSION, id: file.id, description: template.description, body: file.body };
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

  /**
   * Fetch the frame at `depth`, which the reducer has just put into its loading state: a workflow file by
   * its path, or an author-mode template source by its id.
   */
  const fetchFrame = useCallback(
    (frame: Frame, depth: number, seq: number): void => {
      const plugins = pluginsRef.current;
      if (!plugins) return;
      const { path, template } = frame;
      const read = template ? loadTemplateFrame(client, template, plugins) : path !== null ? loadFrame(client, path, plugins) : null;
      void read?.then(({ frameState, etag, baseline, openedBytes }) => {
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
   * The one **persist-and-advance-the-save-point** spine behind `save` and `saveNewFile` (ADR 0016, ADR
   * 0030): set the transient `saving` phase, `PUT` the buffer, and on success dispatch the caller's success
   * action carrying the fresh ETag and the canonical bytes just written. The reducer runs the guarded
   * save-point advance atomically with the `saved` phase, so a save's frame and phase never tear. Each caller
   * `.catch`es the rejection and maps a `412` to its own outcome, so this spine never swallows a failure.
   */
  const commitSave = useCallback(
    <R extends { etag: string }>(args: {
      file: WorkflowFile;
      /** The write itself: `PUT /v0/workflows`, or a template write in author mode (#580). */
      write: (file: JsonValue) => Promise<R>;
      successAction: (result: R, savedBytes: string) => SessionAction;
    }): Promise<R> => {
      apply({ type: "saveStarted" });
      return args
        // The whole authored model, ids and all — the server preserves every `id` it is sent (ADR 0015).
        .write(args.file as unknown as JsonValue)
        .then((result) => {
          // `savedBytes` is the canonical serialization of the exact buffer the server wrote and hashed; the
          // buffer is clean iff it still equals it, so an author who edited *during* the in-flight save stays
          // dirty against the new baseline, which is correct.
          const savedBytes = canonicalSerialize(args.file);
          apply(args.successAction(result, savedBytes));
          return result;
        });
    },
    [apply],
  );

  /** The `PUT /v0/workflows` write for `commitSave`: `path`, under `ifMatch` (absent = exclusive create). */
  const putWorkflowAt = useCallback(
    (path: string, ifMatch: string | undefined) =>
      (workflow: JsonValue): Promise<PutResult> =>
        client.putWorkflow({ workflowPath: path, workflow, ifMatch }),
    [client],
  );

  const save = useCallback((): void => {
    // The door is the reducer's choice (`planSave`): `null` for a from-scratch root, which picks its path
    // in the first-save dialog instead, and otherwise an overwrite under the frame's `If-Match` ETag or an
    // exclusive create at a create-new child's pre-assigned path (ADR 0016).
    const plan = planSave(sessionRef.current);
    if (!plan) return;
    if (plan.kind === "template") {
      // Author mode's write-back (#580): the original template, by id, under the read's `If-Match`. A
      // `412` is the same stale-write conflict as a workflow's; a shipped template's `403` is the API's
      // refusal, shown as the save error it is.
      void commitSave({
        file: plan.file,
        write: () => client.putTemplate({ id: plan.id, body: templateBody(plan.template, plan.file) as JsonValue, ifMatch: plan.ifMatch }),
        successAction: (result, savedBytes) => ({ type: "templateSaved", depth: plan.depth, id: plan.id, etag: result.etag, savedBytes }),
      }).catch((error: unknown) => {
        apply({
          type: "setSaveState",
          saveState:
            error instanceof PathApiError && error.status === 412
              ? { phase: "conflict", message: error.message }
              : { phase: "error", message: errorMessage(error) },
        });
      });
      return;
    }
    void commitSave({
      file: plan.file,
      write: putWorkflowAt(plan.path, plan.ifMatch),
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
  }, [apply, client, commitSave, putWorkflowAt]);

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
        file: plan.file,
        write: putWorkflowAt(targetPath, undefined),
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
    [apply, commitSave, putWorkflowAt],
  );

  const saveAsTemplate = useCallback(
    (name: string, description: string): Promise<SaveAsTemplateResult> => {
      const plan = planTemplateSaveAs(sessionRef.current);
      if (!plan) return Promise.resolve({ status: "error", message: "No template source to save." });
      // A new template is a new identity (ADR 0049 decision 8): only the `id` is re-minted. Node ids stay,
      // since they are unique within the file and Instantiation re-stamps them on use.
      const id = crypto.randomUUID();
      const file: WorkflowFile = { ...plan.file, id };
      const template: TemplateSource = { id, kind: "step", name, description, readOnly: false };
      return commitSave({
        file,
        write: () => client.createTemplate({ kind: "step", name, description, body: templateBody(template, file) }),
        successAction: (result) => ({
          type: "templateSavedAs",
          depth: plan.depth,
          fromId: plan.template.id,
          template: { ...template, id: result.id },
          file,
          etag: result.etag,
        }),
      })
        .then((): SaveAsTemplateResult => ({ status: "created", name }))
        .catch((error: unknown): SaveAsTemplateResult => {
          // Like the first-save dialog, a name collision is the dialog's to show, not the toolbar's.
          apply({ type: "setSaveState", saveState: IDLE });
          if (error instanceof PathApiError && error.status === 409) return { status: "exists" };
          return { status: "error", message: errorMessage(error) };
        });
    },
    [apply, client, commitSave],
  );

  const saveWorkflowAs = useCallback(
    (targetPath: string): Promise<SaveNewFileResult> => {
      const plan = planWorkflowSaveAs(sessionRef.current);
      if (!plan) return Promise.resolve({ status: "error", message: "No workflow to save." });
      const file: WorkflowFile = { ...instantiateWorkflow(plan.file), name: stemName(targetPath) };
      return commitSave({
        file,
        write: putWorkflowAt(targetPath, undefined),
        successAction: (result) => ({ type: "detachedSaved", depth: plan.depth, fromId: plan.file.id, file, relativePath: result.relativePath, etag: result.etag }),
      })
        .then((result): SaveNewFileResult => ({ status: "created", path: result.relativePath }))
        .catch((error: unknown): SaveNewFileResult => {
          apply({ type: "setSaveState", saveState: IDLE });
          if (error instanceof PathApiError && error.status === 412) return { status: "exists" };
          return { status: "error", message: errorMessage(error) };
        });
    },
    [apply, commitSave, putWorkflowAt],
  );

  const saveWorkflowAsTemplate = useCallback(
    (name: string, description: string): Promise<SaveAsTemplateResult> => {
      const plan = planWorkflowSaveAs(sessionRef.current);
      if (!plan) return Promise.resolve({ status: "error", message: "No workflow to save." });
      // Only the `id` is re-minted (ADR 0049 decision 8): node ids stay, since Instantiation re-stamps them on
      // use. Only the body survives; the workflow-level fields are dropped.
      const id = crypto.randomUUID();
      const file: WorkflowFile = { format: plan.file.format, id, name, body: plan.file.body };
      const template: TemplateSource = { id, kind: "step", name, description, readOnly: false };
      apply({ type: "saveStarted" });
      return client
        .createTemplate({ kind: "step", name, description, body: templateBody(template, file) })
        .then((): SaveAsTemplateResult => {
          apply({ type: "setSaveState", saveState: { phase: "saved-as-template", name } });
          return { status: "created", name };
        })
        .catch((error: unknown): SaveAsTemplateResult => {
          apply({ type: "setSaveState", saveState: IDLE });
          if (error instanceof PathApiError && error.status === 409) return { status: "exists" };
          return { status: "error", message: errorMessage(error) };
        });
    },
    [apply, client],
  );

  const saveNewTemplate = useCallback(
    (name: string, description: string): Promise<SaveAsTemplateResult> => {
      const plan = planNewTemplateSave(sessionRef.current);
      if (!plan) return Promise.resolve({ status: "error", message: "No new template to save." });
      const file: WorkflowFile = { ...plan.file, id: crypto.randomUUID() };
      const template: TemplateSource = { id: file.id, kind: "step", name, description, readOnly: false };
      return commitSave({
        file,
        write: () => client.createTemplate({ kind: "step", name, description, body: templateBody(template, file) }),
        successAction: (result) => ({
          type: "templateSavedAs",
          depth: plan.depth,
          fromId: null,
          template: { ...template, id: result.id },
          file,
          etag: result.etag,
        }),
      })
        .then((): SaveAsTemplateResult => ({ status: "created", name }))
        .catch((error: unknown): SaveAsTemplateResult => {
          apply({ type: "setSaveState", saveState: IDLE });
          if (error instanceof PathApiError && error.status === 409) return { status: "exists" };
          return { status: "error", message: errorMessage(error) };
        });
    },
    [apply, client, commitSave],
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

  return { registry, mode: session.mode, switchMode, newTemplate, saveNewTemplate, saveWorkflowAs, saveWorkflowAsTemplate, frames, activeIndex, open, openTemplate, newFile, descend, descendNewUnbound, goTo, applyEdit, undo, redo, save, saveNewFile, saveAsTemplate, reloadActive, deleteActive, saveState };
}
