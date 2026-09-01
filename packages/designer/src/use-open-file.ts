import { useCallback, useEffect, useRef, useState } from "react";
import { PathApiError, type JsonValue, type PathApiClient, type WireStepPlugin } from "@path/client-core";
import type { WorkflowFile } from "@path/schema";
import { openWorkflowFile, type OpenResult } from "./open-workflow.js";
import { resolveRefPath } from "./resolve-ref.js";

/**
 * The Designer's open-and-navigate session (#367): fetch the step-plugin registry once, open a file
 * against it, and track a **navigation stack** of files as a `workflow`-ref descent crosses each
 * boundary (designer-spec § The model). The stack is a trail, not a tree parent — a ref'd file can have
 * several parents — so a breadcrumb built from it pops back by index.
 *
 * The registry is fetched once and reused for every file in the session (one server snapshot). A file
 * fetch or open runs as one guarded async step: a stale completion (the author descended, or popped the
 * breadcrumb, before it landed) is dropped by a monotonic token and a depth+path re-check.
 */

/** The registry fetch state — the received `GET /v0/step-plugins` snapshot the open passes are relative to. */
export type RegistryLoad =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; plugins: WireStepPlugin[] };

/** One file on the navigation stack: its path, where its fetch-and-open got to, and its save baseline. */
export interface Frame {
  path: string;
  state: FrameState;
  /**
   * The `If-Match` ETag for the next save — the strong ETag of the bytes this frame opened, or of the
   * bytes the last successful save wrote. `null` when a proxy stripped the read route's `ETag` header;
   * a save then goes out with no precondition (create-only) and the server refuses an overwrite. Updated
   * to the write route's returned ETag on every successful save, so the next save's baseline is current.
   */
  etag: string | null;
}

/** A frame is fetching, failed to fetch, or has an open outcome (which may itself be a legible refusal). */
export type FrameState =
  | { phase: "loading" }
  | { phase: "fetch-error"; message: string }
  | { phase: "open"; result: OpenResult };

/**
 * The state of the active frame's save (#371, ADR 0016). `saved` is the clean save-point the dirty flag
 * clears against; `conflict` is the `412` stale-write the author must resolve (someone else wrote the
 * file since it opened); `error` is any other write failure.
 */
export type SaveState =
  | { phase: "idle" }
  | { phase: "saving" }
  | { phase: "saved" }
  | { phase: "conflict"; message: string }
  | { phase: "error"; message: string };

export interface OpenSession {
  registry: RegistryLoad;
  /** The navigation stack, root file first; the last frame is the one on the canvas. */
  frames: Frame[];
  /** Open `path` as a fresh root, discarding any current stack. */
  open: (path: string) => void;
  /** Descend across the active file's `workflow`-ref (a relative path), pushing a frame. */
  descend: (ref: string) => void;
  /** Pop the stack back to the breadcrumb entry at `index` (the frames past it are already loaded). */
  goTo: (index: number) => void;
  /** Commit a structure edit to the active (last) frame's opened file, marking the buffer edited (#368). */
  applyEdit: (next: WorkflowFile) => void;
  /**
   * Save the active frame's opened buffer through `PUT /v0/workflows` under its `If-Match` ETag
   * (#371, ADR 0016). On success the buffer becomes clean (a new save-point) and the frame's ETag
   * advances; a `412` becomes a `conflict` the author resolves. A no-op when nothing is open.
   */
  save: () => void;
  /**
   * Re-fetch the active frame from disk, discarding its unsaved buffer for the on-disk bytes and a fresh
   * ETag. The stale-write recovery (#371): after a `412` an author reloads to the latest, then re-edits
   * and saves against the current ETag. A no-op with no file open.
   */
  reloadActive: () => void;
  /** The active frame's save state — drives the save button and the stale-write conflict banner. */
  saveState: SaveState;
}

/** A frame's opened workflow result, or `null` when it is loading, failed to fetch, or is a refusal. */
export type OpenedResult = Extract<OpenResult, { status: "opened" }>;

/**
 * The opened result of a frame, or `null`. The one predicate — "the frame is open and its open
 * succeeded" — that the canvas, the toolbar, and the save path all ask, kept in one place so the four
 * call sites cannot drift.
 */
export function openedResultOf(frame: Frame | undefined): OpenedResult | null {
  if (frame && frame.state.phase === "open" && frame.state.result.status === "opened") return frame.state.result;
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Fetch one file's raw bytes and run the open pipeline; a fetch failure (404, …) becomes a frame error. */
async function loadFrame(
  client: PathApiClient,
  path: string,
  plugins: WireStepPlugin[],
): Promise<{ state: FrameState; etag: string | null }> {
  try {
    const raw = await client.getWorkflowFile(path);
    return { state: { phase: "open", result: openWorkflowFile(raw.text, plugins) }, etag: raw.etag };
  } catch (error) {
    return { state: { phase: "fetch-error", message: errorMessage(error) }, etag: null };
  }
}

export function useOpenFile(client: PathApiClient, initialPath?: string): OpenSession {
  const [registry, setRegistry] = useState<RegistryLoad>({ phase: "loading" });
  const [frames, setFrames] = useState<Frame[]>([]);
  const [saveState, setSaveState] = useState<SaveState>({ phase: "idle" });

  // A ref mirror of `frames`, so `descend` reads the current stack without re-subscribing; and the
  // registry plugins, so an open callback reads them without waiting on a state read.
  const framesRef = useRef<Frame[]>([]);
  useEffect(() => {
    framesRef.current = frames;
  }, [frames]);
  const pluginsRef = useRef<WireStepPlugin[] | null>(null);

  // A monotonic token: only the newest in-flight load may patch state. Bumped on every open, descend,
  // and pop, so a load whose destination the author already left is dropped.
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
    (path: string, depth: number, plugins: WireStepPlugin[]): void => {
      const token = ++loadToken.current;
      void loadFrame(client, path, plugins).then(({ state, etag }) => {
        if (token !== loadToken.current) return;
        setFrames((prev) => {
          if (depth >= prev.length || prev[depth]?.path !== path) return prev;
          const next = prev.slice();
          next[depth] = { path, state, etag };
          return next;
        });
      });
    },
    [client],
  );

  const open = useCallback(
    (path: string): void => {
      const plugins = pluginsRef.current;
      if (!plugins) return;
      setSaveState({ phase: "idle" });
      setFrames([{ path, state: { phase: "loading" }, etag: null }]);
      runLoad(path, 0, plugins);
    },
    [runLoad],
  );

  const descend = useCallback(
    (ref: string): void => {
      const plugins = pluginsRef.current;
      const current = framesRef.current[framesRef.current.length - 1];
      if (!plugins || !current) return;
      const path = resolveRefPath(current.path, ref);
      const depth = framesRef.current.length;
      setSaveState({ phase: "idle" });
      setFrames((prev) => [...prev, { path, state: { phase: "loading" }, etag: null }]);
      runLoad(path, depth, plugins);
    },
    [runLoad],
  );

  const goTo = useCallback((index: number): void => {
    // Any deeper in-flight load is now stale; bump the token so it cannot patch the truncated stack.
    loadToken.current++;
    setSaveState({ phase: "idle" });
    setFrames((prev) => (index < 0 || index >= prev.length ? prev : prev.slice(0, index + 1)));
  }, []);

  const applyEdit = useCallback((next: WorkflowFile): void => {
    // An edit moves the buffer off its last save-point, so a stale "saved"/"conflict"/"error" no longer
    // describes it: fall back to idle. The buffer is now dirty again (`edited: true`).
    setSaveState({ phase: "idle" });
    setFrames((prev) => {
      const depth = prev.length - 1;
      const frame = prev[depth];
      if (!frame || frame.state.phase !== "open" || frame.state.result.status !== "opened") return prev;
      const patched = prev.slice();
      patched[depth] = { ...frame, state: { phase: "open", result: { ...frame.state.result, file: next, edited: true } } };
      return patched;
    });
  }, []);

  const reloadActive = useCallback((): void => {
    const plugins = pluginsRef.current;
    const depth = framesRef.current.length - 1;
    const active = framesRef.current[depth];
    if (!plugins || !active) return;
    setSaveState({ phase: "idle" });
    setFrames((prev) => {
      const next = prev.slice();
      next[depth] = { path: active.path, state: { phase: "loading" }, etag: null };
      return next;
    });
    runLoad(active.path, depth, plugins);
  }, [runLoad]);

  const save = useCallback((): void => {
    const depth = framesRef.current.length - 1;
    const active = framesRef.current[depth];
    const opened = openedResultOf(active);
    if (!active || !opened) return;
    const { path } = active;
    const file = opened.file;
    setSaveState({ phase: "saving" });
    void client
      .putWorkflow({
        workflowPath: path,
        // The whole authored model, ids and all — the server preserves every `id` it is sent (ADR 0015).
        workflow: file as unknown as JsonValue,
        ifMatch: active.etag ?? undefined,
      })
      .then((result) => {
        setSaveState({ phase: "saved" });
        // Advance the frame to the new clean save-point: the write route's fresh ETag becomes the next
        // `If-Match`, and the buffer is clean (edited/dirty cleared). Re-check the top frame is still the
        // same file — an author who navigated away mid-save must not have that frame re-marked clean.
        setFrames((prev) => {
          const top = prev[depth];
          const topResult = openedResultOf(top);
          if (!top || top.path !== path || !topResult) return prev;
          const patched = prev.slice();
          patched[depth] = {
            ...top,
            etag: result.etag,
            state: { phase: "open", result: { ...topResult, edited: false, dirty: false } },
          };
          return patched;
        });
      })
      .catch((error: unknown) => {
        if (error instanceof PathApiError && error.status === 412) {
          setSaveState({ phase: "conflict", message: error.message });
        } else {
          setSaveState({ phase: "error", message: errorMessage(error) });
        }
      });
  }, [client]);

  // Open the initial deep-link once the registry is ready. Guarded so it fires once, not on every
  // registry re-render.
  const openedInitial = useRef(false);
  useEffect(() => {
    if (registry.phase === "ready" && initialPath && !openedInitial.current) {
      openedInitial.current = true;
      open(initialPath);
    }
  }, [registry, initialPath, open]);

  return { registry, frames, open, descend, goTo, applyEdit, save, reloadActive, saveState };
}
