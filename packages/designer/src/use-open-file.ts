import type { PathApiClient, WireStepPlugin } from "@path/client-core";
import { errorMessage } from "@path/viewer";
import { useCallback, useEffect, useRef, useState } from "react";
import { loadDocument, writeDocument } from "./document.js";
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
  type SessionState,
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
  planDownload,
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
  mode: EditMode;
  /** The active frame's save state — drives the save button and the stale-write conflict banner. */
  saveState: SaveState;
  /**
   * Apply one session action. The reducer owns every transition and the read it asks for; this hook
   * only performs that read — and queues it until the step-plugin registry lands, so an early open
   * or descend waits rather than vanishing.
   */
  apply: (action: SessionAction) => void;
  /** Save the active buffer under its `If-Match` ETag (ADR 0016); a `412` becomes a `conflict` to
   * resolve. */
  save: () => void;
  /** Write the active buffer to a document it does not yet have; `workflow-as-template` leaves the
   * workflow open. */
  saveAs: (intent: SaveAsIntent) => Promise<SaveAsResult>;
  /**
   * Delete the root file (`planDelete`): a workflow under its read's `If-Match` with this session's
   * lease, or a template by id.
   */
  deleteActive: (sessionId: string) => void;
}

export function useOpenFile(client: PathApiClient, initialPath?: string): OpenSession {
  const [registry, setRegistry] = useState<RegistryLoad>({ phase: "loading" });
  const [session, setSession] = useState<SessionState>(initialSessionState);
  const { frames, activeIndex, saveState } = session;

  // The current session state, readable synchronously by `apply` and by the I/O callbacks. It
  // advances with the dispatch rather than a render later, so two actions in one tick cannot read a
  // stale trail.
  const sessionRef = useRef(session);
  const pluginsRef = useRef<WireStepPlugin[] | null>(null);
  // The reads the reducer asked for before the registry landed. A read is a fact the author
  // requested, so it waits for its parser rather than being dropped.
  const queuedFetches = useRef<FetchRequest[]>([]);
  // The current `apply`, for a load landing that must dispatch after the fetch resolves.
  const applyRef = useRef<(action: SessionAction) => void>(() => {});

  /** Perform the read the reducer asked for, echoing its token back so a landing the author has
   * since outrun is dropped. */
  const performFetch = useCallback(
    (request: FetchRequest): void => {
      const plugins = pluginsRef.current;
      if (!plugins) {
        queuedFetches.current.push(request);
        return;
      }
      const { frame, depth, token } = request;
      void loadDocument(client, frame, plugins).then((loaded) => {
        if (loaded) {
          applyRef.current({ type: "loadLanded", depth, path: frame.path, token, ...loaded });
        }
      });
    },
    [client],
  );

  /** Apply one action and run the read it asked for: the whole shape of an I/O step, and the one
   * verb every caller edits the session through. */
  const apply = useCallback(
    (action: SessionAction): void => {
      const outcome = reduceSession(sessionRef.current, action);
      sessionRef.current = outcome.state;
      setSession(outcome.state);
      if (outcome.fetch) performFetch(outcome.fetch);
    },
    [performFetch],
  );

  useEffect(() => {
    applyRef.current = apply;
  }, [apply]);

  useEffect(() => {
    let alive = true;
    client
      .getStepPlugins()
      .then((response) => {
        if (!alive) return;
        pluginsRef.current = response.step_plugins;
        setRegistry({ phase: "ready", plugins: response.step_plugins });
        const queued = queuedFetches.current;
        queuedFetches.current = [];
        for (const request of queued) performFetch(request);
      })
      .catch((error: unknown) => {
        if (alive) setRegistry({ phase: "error", message: errorMessage(error) });
      });
    return () => {
      alive = false;
    };
  }, [client, performFetch]);

  // The deep-link open, applied once: the read queues behind the registry if it has not landed.
  const openedInitial = useRef(false);
  useEffect(() => {
    if (initialPath === undefined || openedInitial.current) return;
    openedInitial.current = true;
    apply({ type: "openLoading", path: initialPath });
  }, [initialPath, apply]);

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

  return {
    registry,
    mode: session.mode,
    frames,
    activeIndex,
    saveState,
    apply,
    save,
    saveAs,
    deleteActive,
  };
}
