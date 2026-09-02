import { useCallback, useEffect, useRef, useState } from "react";
import { PathApiError, type JsonValue, type PathApiClient, type WireStepPlugin } from "@path/client-core";
import type { WorkflowFile } from "@path/schema";
import { openWorkflowFile, type OpenResult } from "./open-workflow.js";
import { resolveRefPath } from "./resolve-ref.js";
import { canonicalSerialize } from "./serialize.js";

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

/** One file on the navigation stack: its path, where its fetch-and-open got to, and its save-point. */
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
  /**
   * The **baseline**: the on-disk bytes the frame last synced (ADR 0030) — the raw text this frame
   * opened, or `canonicalSerialize(buffer)` of the bytes the last `200` save wrote. The buffer is
   * **clean** when `canonicalSerialize(buffer) === baseline`, **dirty** otherwise: a content comparison,
   * not a mutation flag. It pairs with `etag` (same save-point, ADR 0025), and advances only on a `200`
   * save. Empty until the frame's fetch-and-open lands.
   */
  baseline: string;
  /**
   * `canonicalSerialize(buffer)` at the last save-point — the buffer's bytes at open, then at each `200`
   * save. It only steers the badge's wording (an id-stamp-only dirty vs an authored edit); dirtiness is the
   * `baseline` comparison above. Empty until the frame opens. It differs from `baseline` only at open of a
   * non-canonical file (baseline is the raw disk bytes, this is their canonical form); a save aligns them.
   */
  openedBytes: string;
  /** This frame's own undo/redo stack (#389). Independent per open file; survives this frame's saves. */
  history: History;
}

/** A frame is fetching, failed to fetch, or has an open outcome (which may itself be a legible refusal). */
export type FrameState =
  | { phase: "loading" }
  | { phase: "fetch-error"; message: string }
  | { phase: "open"; result: OpenResult };

/**
 * The undo/redo history of one frame (#389, designer-spec § Dirty-state, undo, and the save-point). The
 * **present** is the frame's open buffer (`state.result.file`), not held here; `past` and `future` are the
 * snapshots either side of it. One entry per structural edit (add/delete/reorder/replace) or per
 * **coalesced** field edit — a run of keystrokes in one field folds to the single entry that opened the
 * run. It is **per-frame**, so the parent and every descended ref child keep an independent stack, and it
 * **survives a save**: the save advances the baseline, not the history, so undoing past the save-point
 * re-dirties the buffer (clean is content-equality, ADR 0030, re-derived after every undo/redo — nothing
 * special here re-evaluates it). Redo is cleared by any new edit.
 */
export interface History {
  /** Buffers before the present, oldest first; the last is the next undo target. */
  past: WorkflowFile[];
  /** Buffers ahead of the present (redo), next-redo first; cleared by any new edit. */
  future: WorkflowFile[];
  /**
   * The coalesce key of the in-progress field run, or `undefined` when the last commit closed a run (a
   * structural edit, an undo, or a redo). A field edit whose key equals this folds into the current
   * entry; any other key, or a structural edit (no key), opens a new entry.
   */
  coalesceKey: string | undefined;
}

/** A fresh, empty history — the state every frame opens (and re-opens, on a reload) with. */
function freshHistory(): History {
  return { past: [], future: [], coalesceKey: undefined };
}

/**
 * The state of the active frame's save (#371, ADR 0016) — a transient UI phase, not the dirty relation:
 * `saved` shows the "Saved." confirmation after a `200` advanced the baseline (ADR 0030 keeps the content
 * relation, not this phase, as the definition of clean); `conflict` is the `412` stale-write the author
 * must resolve (someone else wrote the file since it opened); `error` is any other write failure.
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
  /**
   * Commit an edit to the active (last) frame's opened file; dirtiness re-derives (#368, ADR 0030) and an
   * undo entry is recorded (#389). A structural edit passes no `coalesce` key (one entry each); a field
   * edit passes a stable key so a run of keystrokes in that one field folds to a single entry. Any edit
   * clears the frame's redo stack.
   */
  applyEdit: (next: WorkflowFile, coalesce?: string) => void;
  /** Undo the active frame's last edit, re-deriving clean (#389). A no-op when its past stack is empty. */
  undo: () => void;
  /** Redo the active frame's last undo, re-deriving clean (#389). A no-op when its future stack is empty. */
  redo: () => void;
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

/**
 * The one definition of **dirty** (ADR 0030): an opened frame's buffer is dirty when its canonical
 * serialization no longer equals the frame's `baseline`, clean when it does — the single content relation
 * that launch (save-first, ADR 0025), the Save button, and the dirty badge all read, so the three cannot
 * drift. A frame that is loading, failed, or is a refusal is clean (there is no buffer to save).
 */
export function frameDirty(frame: Frame | undefined): boolean {
  const opened = openedResultOf(frame);
  if (!frame || !opened) return false;
  return canonicalSerialize(opened.file) !== frame.baseline;
}

/** Has the active frame an edit to undo (#389)? Drives the toolbar's Undo button and its keyboard peer. */
export function frameCanUndo(frame: Frame | undefined): boolean {
  return frame !== undefined && frame.history.past.length > 0;
}

/** Has the active frame an undo to redo (#389)? Drives the toolbar's Redo button and its keyboard peer. */
export function frameCanRedo(frame: Frame | undefined): boolean {
  return frame !== undefined && frame.history.future.length > 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A fresh loading frame for `path`: no ETag, an empty save-point, and an empty history until it opens. */
function loadingFrame(path: string): Frame {
  return { path, state: { phase: "loading" }, etag: null, baseline: "", openedBytes: "", history: freshHistory() };
}

/** Fetch one file's raw bytes and run the open pipeline; a fetch failure (404, …) becomes a frame error. */
async function loadFrame(
  client: PathApiClient,
  path: string,
  plugins: WireStepPlugin[],
): Promise<{ state: FrameState; etag: string | null; baseline: string; openedBytes: string }> {
  try {
    const raw = await client.getWorkflowFile(path);
    const result = openWorkflowFile(raw.text, plugins);
    // The baseline is the raw on-disk bytes (ADR 0030): a buffer whose canonical serialization differs
    // from them — an id-stamp repair, or a non-canonical hand-authored file — opens dirty, because a
    // save would write different bytes. `openedBytes` is the buffer's own canonical form at open, for the
    // badge's stamp-vs-edit wording.
    const openedBytes = result.status === "opened" ? canonicalSerialize(result.file) : "";
    return { state: { phase: "open", result }, etag: raw.etag, baseline: raw.text, openedBytes };
  } catch (error) {
    return { state: { phase: "fetch-error", message: errorMessage(error) }, etag: null, baseline: "", openedBytes: "" };
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
      void loadFrame(client, path, plugins).then(({ state, etag, baseline, openedBytes }) => {
        if (token !== loadToken.current) return;
        setFrames((prev) => {
          if (depth >= prev.length || prev[depth]?.path !== path) return prev;
          const next = prev.slice();
          // A fresh open (or reload) resets the frame's history: the buffer that just landed is the new
          // save-point, with nothing to undo back past.
          next[depth] = { path, state, etag, baseline, openedBytes, history: freshHistory() };
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
      setFrames([loadingFrame(path)]);
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
      setFrames((prev) => [...prev, loadingFrame(path)]);
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

  const applyEdit = useCallback((next: WorkflowFile, coalesce?: string): void => {
    // An edit moves the buffer off its last save-point, so a stale "saved"/"conflict"/"error" no longer
    // describes it: fall back to idle. Dirtiness is not a flag set here — it is re-derived from the new
    // buffer's canonical serialization against `baseline` (ADR 0030), so a round-trip edit reads clean.
    setSaveState({ phase: "idle" });
    setFrames((prev) => {
      const depth = prev.length - 1;
      const frame = prev[depth];
      const opened = openedResultOf(frame);
      if (!frame || !opened) return prev;
      // Record an undo entry (#389). A field edit whose key matches the run in progress **folds** — the
      // present buffer is the run's intermediate, dropped so undo jumps to where the run began; the entry
      // already on `past` is the run-start snapshot. Any other key, or a structural edit (no key), pushes
      // the present as a new entry. Either way this is a new edit, so redo is cleared.
      const fold = coalesce !== undefined && coalesce === frame.history.coalesceKey;
      const past = fold ? frame.history.past : [...frame.history.past, opened.file];
      const patched = prev.slice();
      patched[depth] = {
        ...frame,
        state: { phase: "open", result: { ...opened, file: next } },
        history: { past, future: [], coalesceKey: coalesce },
      };
      return patched;
    });
  }, []);

  const undo = useCallback((): void => {
    // Guard on the current stack before touching state, so a no-op undo (empty past) does not clear a
    // standing "Saved."/conflict status or spin a redundant re-render.
    if (!frameCanUndo(framesRef.current[framesRef.current.length - 1])) return;
    setSaveState({ phase: "idle" });
    setFrames((prev) => {
      const depth = prev.length - 1;
      const frame = prev[depth];
      const opened = openedResultOf(frame);
      if (!frame || !opened || frame.history.past.length === 0) return prev;
      const past = frame.history.past.slice();
      const restored = past.pop()!;
      // The present moves to the redo stack; clean re-derives from `restored` against the (unchanged)
      // baseline, so an undo past the save-point re-dirties the buffer for free (ADR 0030). Close any
      // coalesce run so a following field edit opens a fresh entry rather than folding into the undone one.
      const patched = prev.slice();
      patched[depth] = {
        ...frame,
        state: { phase: "open", result: { ...opened, file: restored } },
        history: { past, future: [opened.file, ...frame.history.future], coalesceKey: undefined },
      };
      return patched;
    });
  }, []);

  const redo = useCallback((): void => {
    if (!frameCanRedo(framesRef.current[framesRef.current.length - 1])) return;
    setSaveState({ phase: "idle" });
    setFrames((prev) => {
      const depth = prev.length - 1;
      const frame = prev[depth];
      const opened = openedResultOf(frame);
      if (!frame || !opened || frame.history.future.length === 0) return prev;
      const future = frame.history.future.slice();
      const restored = future.shift()!;
      const patched = prev.slice();
      patched[depth] = {
        ...frame,
        state: { phase: "open", result: { ...opened, file: restored } },
        history: { past: [...frame.history.past, opened.file], future, coalesceKey: undefined },
      };
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
      next[depth] = loadingFrame(active.path);
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
        // Advance the save-point to the bytes just written (ADR 0030): `baseline` becomes the canonical
        // serialization of the **saved** buffer (`file`, captured above — the exact bytes the server
        // wrote and hashed) and `etag` becomes the write route's fresh ETag for the next `If-Match`. The
        // buffer is now clean iff it still equals `file`; an author who edited *during* the in-flight save
        // stays dirty against the new baseline, which is correct. Re-check the top frame is still the same
        // file — an author who navigated away mid-save must not have that frame re-based.
        const savedBytes = canonicalSerialize(file);
        setFrames((prev) => {
          const top = prev[depth];
          const topResult = openedResultOf(top);
          if (!top || top.path !== path || !topResult) return prev;
          const patched = prev.slice();
          // `openedBytes` moves to the new save-point too, so the badge's stamp-vs-edit wording measures
          // "changed since the last save", not since first open: a saved id-stamp is persisted, no longer
          // the "stamped on import" reason.
          patched[depth] = { ...top, etag: result.etag, baseline: savedBytes, openedBytes: savedBytes };
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

  return { registry, frames, open, descend, goTo, applyEdit, undo, redo, save, reloadActive, saveState };
}
