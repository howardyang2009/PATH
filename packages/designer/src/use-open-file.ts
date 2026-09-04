import { useCallback, useEffect, useRef, useState } from "react";
import { PathApiError, type JsonValue, type PathApiClient, type WireStepPlugin } from "@path/client-core";
import { FORMAT_VERSION, type WorkflowFile, type WorkflowNode } from "@path/schema";
import { openWorkflowFile, type OpenResult } from "./open-workflow.js";
import { findById, replaceNode } from "./edit-tree.js";
import { basename, relativeRefPath, resolveRefPath } from "./resolve-ref.js";
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
  /**
   * The file's project-relative path, or **`null`** for a from-scratch buffer that holds no path until
   * its first save (#390, designer-spec § New-file placement and naming). A `null`-path frame takes no
   * lease and cannot launch; `saveNewFile` chooses the path at first save, after which it is a saved
   * frame like any other. Every other frame — an opened file, a `workflow`-ref descent — carries a path.
   */
  path: string | null;
  /**
   * Has this buffer been **persisted to disk**? A saved file — opened, reloaded, or after a successful
   * save — is `true`; a from-scratch buffer (#390) and a create-new nested child (#391) are `false` until
   * their first save, even though the child already carries its pre-assigned `path`. It is the discriminator
   * the from-scratch rule reads: an **unwritten** frame takes no lease and cannot launch, and its first
   * save is an **exclusive create** (no `If-Match`, ADR 0016), not an overwrite. `path === null` no longer
   * carries this fact alone, because a create-new child is unwritten *with* a path.
   */
  written: boolean;
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
  /**
   * A create-new nested-ref child's back-link to the `workflow` node that spawned it (#391): the parent
   * frame's `depth` on the trail and that node's `id`. Set only on a fresh, unwritten child descended
   * before its path was chosen; consumed at the child's **first save**, which back-fills the parent node's
   * `ref` from the path the child was actually saved to (so the ref is filled by the save, not chosen up
   * front). `undefined` for every other frame, and cleared once the child is bound.
   */
  refParent?: { depth: number; nodeId: string };
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

/**
 * The outcome of a from-scratch buffer's first save (#390, designer-spec § New-file placement and
 * naming). A new-file save is an **exclusive create** (no `If-Match`, ADR 0016): the server refuses an
 * existing path with a `412`, which reads here as `exists` — the dialog's "choose another name", never a
 * silent overwrite. `created` reports the path the server echoed; the frame is now saved (path, ETag, and
 * baseline advanced, and the lease acquired by the App's per-path effect). `error` is any other failure
 * (a `404` for a path escaping the project root, or a `400` validation refusal).
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
   * index without discarding the deeper frames, so a descended child keeps its dirty buffer and its
   * beating lease while the parent is on screen (#391, designer-spec § Nested `workflow`-ref creation).
   */
  frames: Frame[];
  /** The index of the active frame in `frames` — what the canvas renders and every edit/save op targets. */
  activeIndex: number;
  /** Open `path` as a fresh root, discarding any current stack. */
  open: (path: string) => void;
  /**
   * Start a **from-scratch** buffer as a fresh root, discarding any current stack (#390). The frame holds
   * **no path and no lease** (§ Session lifecycle): an empty, editable workflow whose placement is decided
   * at its first `saveNewFile`. Reads dirty from open (nothing on disk to match), so Save is live at once.
   */
  newFile: () => void;
  /**
   * Descend across the active file's `workflow`-ref (a relative path), making a child frame active. If the
   * frame just ahead of the active one already holds that resolved target (a re-entry down the same trail),
   * it is **reused** — the author returns to its live, possibly-dirty buffer; otherwise the forward trail is
   * truncated and the target is loaded fresh.
   */
  descend: (ref: string) => void;
  /**
   * Descend into a **fresh, unwritten, path-less** child buffer for a create-new nested ref (#391), linked
   * back to the `workflow` node `parentNodeId` in the active (parent) frame. The child follows the
   * from-scratch rule exactly — no path, no lease, no launch, and its first save is the same path-choosing
   * exclusive create a new **root** takes — except that first save also **back-fills the parent node's
   * `ref`** from the path the child is saved to. So the ref is filled by the save, never chosen up front.
   * The forward trail is truncated and the new child becomes active.
   */
  descendNewUnbound: (parentNodeId: string) => void;
  /** Make the breadcrumb entry at `index` active — an ascend or a forward re-entry; no frame is discarded. */
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
   * First-save a from-scratch buffer to `targetPath` as an **exclusive create** (#390, ADR 0016): a
   * `PUT` with no `If-Match`, so the server refuses an existing path (`412` → `exists`) rather than
   * overwrite it. On `created` the active frame's path, ETag, and baseline advance to the written file, so
   * it becomes a saved frame (the App then acquires its lease and launch enables). A no-op — `error` — when
   * the active frame is not a `null`-path buffer.
   */
  saveNewFile: (targetPath: string) => Promise<SaveNewFileResult>;
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
  // It targets an on-disk file, so it is `written`; the lease/launch gates read `openedResultOf` too, so
  // a still-loading frame is not yet leased regardless.
  return { path, written: true, state: { phase: "loading" }, etag: null, baseline: "", openedBytes: "", history: freshHistory() };
}

/**
 * The default `name` a from-scratch buffer opens with (#390). It slugs cleanly to a filename
 * (`^[a-z][a-z0-9-]*$`, CONTEXT.md § Identity), so the first-save dialog can prefill
 * `untitled.workflow.json`; the author renames it in the pane before saving.
 */
const NEW_FILE_DEFAULT_NAME = "untitled";

/**
 * A from-scratch buffer's frame: an empty, id-bearing **unwritten** workflow, with no ETag and no lease
 * until its first save. Its `baseline` is the empty string — no on-disk bytes exist for it to equal — so
 * the buffer reads dirty from open through the one dirty relation (`frameDirty`), which keeps Save live.
 *
 * `path` is `null` for a new **root** (#390 — placement is decided at the first-save dialog), or the
 * pre-assigned child path for a create-new nested ref (#391 — placement is already decided, so the child's
 * first save is an exclusive create straight to that path). Either way the frame is `written: false`. The
 * child's `name` is seeded from its filename stem so its breadcrumb and pane read sensibly before a save.
 */
function scratchFrame(path: string | null = null, refParent?: { depth: number; nodeId: string }): Frame {
  const name = path === null ? NEW_FILE_DEFAULT_NAME : stemName(path);
  const file: WorkflowFile = { format: FORMAT_VERSION, id: crypto.randomUUID(), name, body: [] };
  const openedBytes = canonicalSerialize(file);
  return {
    path,
    written: false,
    state: { phase: "open", result: { status: "opened", file, idsStamped: false } },
    etag: null,
    baseline: "",
    openedBytes,
    history: freshHistory(),
    refParent,
  };
}

/**
 * The default workflow `name` for a create-new child, taken from its filename stem (the `.workflow.json`
 * suffix and the directory dropped). It falls back to the from-scratch default when a stem does not slug
 * to a legal name (`^[a-z][a-z0-9-]*$`), so the buffer always opens with a name the author can save.
 */
function stemName(path: string): string {
  const stem = basename(path).replace(/\.workflow\.json$/i, "");
  return /^[a-z][a-z0-9-]*$/.test(stem) ? stem : NEW_FILE_DEFAULT_NAME;
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
  // Which frame the canvas/pane/toolbar act on. Decoupled from the trail's tip so an ascend (`goTo`) keeps
  // the deeper frames alive (a dirty descended child survives, #391). Reset to the root on every new open.
  const [activeIndex, setActiveIndex] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>({ phase: "idle" });

  // Ref mirrors of `frames` and `activeIndex`, so the callbacks read the current trail without
  // re-subscribing; and the registry plugins, so an open callback reads them without waiting on a state read.
  const framesRef = useRef<Frame[]>([]);
  useEffect(() => {
    framesRef.current = frames;
  }, [frames]);
  const activeIndexRef = useRef(0);
  useEffect(() => {
    activeIndexRef.current = activeIndex;
  }, [activeIndex]);
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
          // save-point, with nothing to undo back past. A loaded frame is on disk, so it is `written`.
          next[depth] = { path, written: true, state, etag, baseline, openedBytes, history: freshHistory() };
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
      setActiveIndex(0);
      runLoad(path, 0, plugins);
    },
    [runLoad],
  );

  const newFile = useCallback((): void => {
    // A from-scratch buffer needs no registry fetch to open — it starts empty — but the palette still
    // reads the registry to arm kinds, so this is available the moment the app mounts. Bump the load
    // token so any in-flight fetch cannot patch the discarded stack.
    loadToken.current++;
    setSaveState({ phase: "idle" });
    setFrames([scratchFrame()]);
    setActiveIndex(0);
  }, []);

  const descend = useCallback(
    (ref: string): void => {
      const plugins = pluginsRef.current;
      const depth = activeIndexRef.current;
      const current = framesRef.current[depth];
      // A descent crosses a `workflow`-ref of the active file, so the active frame must carry a path to
      // resolve the ref against; a from-scratch root buffer (no path) has no ref to descend.
      if (!plugins || !current || current.path === null) return;
      const path = resolveRefPath(current.path, ref);
      // Re-entry down the same trail: if the frame just ahead already holds this target, reuse it — the
      // author returns to its live buffer (a dirty descended child is not reloaded out from under them).
      const ahead = framesRef.current[depth + 1];
      if (ahead && ahead.path === path) {
        setSaveState({ phase: "idle" });
        setActiveIndex(depth + 1);
        return;
      }
      // Otherwise truncate the forward trail and load the target fresh below the active frame.
      const childDepth = depth + 1;
      setSaveState({ phase: "idle" });
      setFrames((prev) => [...prev.slice(0, childDepth), loadingFrame(path)]);
      setActiveIndex(childDepth);
      runLoad(path, childDepth, plugins);
    },
    [runLoad],
  );

  const descendNewUnbound = useCallback((parentNodeId: string): void => {
    const depth = activeIndexRef.current;
    const current = framesRef.current[depth];
    if (!current) return;
    // A create-new child is a fresh, unwritten, path-less buffer, linked back to the parent node that
    // spawned it so its first save can back-fill the ref. Truncate any forward trail and push it below the
    // active frame. Bump the load token so no in-flight load patches the truncated trail.
    loadToken.current++;
    const childDepth = depth + 1;
    setSaveState({ phase: "idle" });
    setFrames((prev) => [...prev.slice(0, childDepth), scratchFrame(null, { depth, nodeId: parentNodeId })]);
    setActiveIndex(childDepth);
  }, []);

  const goTo = useCallback((index: number): void => {
    // An ascend (or forward re-entry) only moves the active frame — no frame is discarded, so a dirty
    // descended child keeps its buffer and its beating lease. A pending load stays valid (its frame is
    // still on the trail at the same depth), so the load token is left untouched.
    setSaveState({ phase: "idle" });
    setActiveIndex((prev) => (index < 0 || index >= framesRef.current.length ? prev : index));
  }, []);

  const applyEdit = useCallback((next: WorkflowFile, coalesce?: string): void => {
    // An edit moves the buffer off its last save-point, so a stale "saved"/"conflict"/"error" no longer
    // describes it: fall back to idle. Dirtiness is not a flag set here — it is re-derived from the new
    // buffer's canonical serialization against `baseline` (ADR 0030), so a round-trip edit reads clean.
    setSaveState({ phase: "idle" });
    setFrames((prev) => {
      const depth = activeIndexRef.current;
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
    if (!frameCanUndo(framesRef.current[activeIndexRef.current])) return;
    setSaveState({ phase: "idle" });
    setFrames((prev) => {
      const depth = activeIndexRef.current;
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
    if (!frameCanRedo(framesRef.current[activeIndexRef.current])) return;
    setSaveState({ phase: "idle" });
    setFrames((prev) => {
      const depth = activeIndexRef.current;
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
    const depth = activeIndexRef.current;
    const active = framesRef.current[depth];
    // An unwritten buffer (a from-scratch root, or a create-new child) has no on-disk bytes to re-fetch —
    // reload is a no-op for it, and would discard the authored buffer for a 404.
    if (!plugins || !active || !active.written || active.path === null) return;
    const { path } = active;
    setSaveState({ phase: "idle" });
    setFrames((prev) => {
      const next = prev.slice();
      next[depth] = loadingFrame(path);
      return next;
    });
    runLoad(path, depth, plugins);
  }, [runLoad]);

  const save = useCallback((): void => {
    const depth = activeIndexRef.current;
    const active = framesRef.current[depth];
    const opened = openedResultOf(active);
    // A from-scratch **root** (no path) picks its path in the first-save dialog, which calls `saveNewFile`;
    // it never reaches this door. Every other active frame saves here — an overwrite for a written file, an
    // exclusive create at the pre-assigned path for an unwritten create-new child (#391).
    if (!active || !opened || active.path === null) return;
    const { path, written } = active;
    const file = opened.file;
    setSaveState({ phase: "saving" });
    void client
      .putWorkflow({
        workflowPath: path,
        // The whole authored model, ids and all — the server preserves every `id` it is sent (ADR 0015).
        workflow: file as unknown as JsonValue,
        // A written file overwrites under its `If-Match` ETag; an unwritten child creates exclusively
        // (no precondition, ADR 0016), so the server refuses an existing path rather than clobbering it.
        ifMatch: written ? (active.etag ?? undefined) : undefined,
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
          // the "stamped on import" reason. The child's first save also flips `written`, so its lease is
          // now acquired and launch enables — the from-scratch rule lifts at the first save.
          patched[depth] = { ...top, written: true, etag: result.etag, baseline: savedBytes, openedBytes: savedBytes };
          return patched;
        });
      })
      .catch((error: unknown) => {
        if (error instanceof PathApiError && error.status === 412) {
          // A `412` on a written file's overwrite is the stale-write conflict (someone else wrote it). On
          // an unwritten child's exclusive create it means the path already exists — a create collision,
          // not a stale write, so it is an error the author resolves by retargeting, not by reloading.
          setSaveState(
            written
              ? { phase: "conflict", message: error.message }
              : { phase: "error", message: `A workflow already exists at ${path}. Choose a different target for the reference.` },
          );
        } else {
          setSaveState({ phase: "error", message: errorMessage(error) });
        }
      });
  }, [client]);

  const saveNewFile = useCallback(
    (targetPath: string): Promise<SaveNewFileResult> => {
      const depth = activeIndexRef.current;
      const active = framesRef.current[depth];
      const opened = openedResultOf(active);
      // Only a from-scratch **root** buffer (unwritten, no path) picks its path here; a create-new child
      // (unwritten, path pre-assigned) and a saved frame both go through `save`.
      if (!active || !opened || active.written || active.path !== null) {
        return Promise.resolve({ status: "error", message: "No new-file buffer to save." });
      }
      const file = opened.file;
      setSaveState({ phase: "saving" });
      // Exclusive create (ADR 0016): no `If-Match`, so the server refuses an existing path with a `412`
      // rather than overwriting another workflow. The server echoes the resolved `relative_path`, which
      // the frame adopts as its path — placement decided at this first save.
      return client
        .putWorkflow({ workflowPath: targetPath, workflow: file as unknown as JsonValue })
        .then((result): SaveNewFileResult => {
          const savedBytes = canonicalSerialize(file);
          setSaveState({ phase: "saved" });
          setFrames((prev) => {
            const top = prev[depth];
            const topResult = openedResultOf(top);
            // Guard the still-a-scratch-buffer at this depth (an author who navigated mid-save must not
            // have a stale frame re-based) — the same top-frame re-check `save` makes.
            if (!top || top.written || top.path !== null || !topResult) return prev;
            const patched = prev.slice();
            // The child is now a saved frame; drop its `refParent` link — it is bound, and a re-save goes
            // through the written-file `save` door, never here.
            patched[depth] = { ...top, written: true, path: result.relativePath, etag: result.etag, baseline: savedBytes, openedBytes: savedBytes, refParent: undefined };
            // Back-fill the parent node's `ref` (#391) from the path the child was actually saved to, so a
            // create-new ref is filled by the save rather than chosen up front. The parent buffer moves off
            // its baseline (it gains the ref), so it reads dirty — the author saves it like any edit. Skip
            // silently if the parent frame or its `workflow` node is gone (the author deleted it, or the
            // parent lost its path), which leaves the freshly-saved child standing on its own.
            const link = top.refParent;
            const parent = link ? patched[link.depth] : undefined;
            const parentResult = openedResultOf(parent);
            if (link && parent && parentResult && parent.path !== null) {
              const node = findById(parentResult.file.body, link.nodeId);
              if (node && node.type === "workflow") {
                const ref = relativeRefPath(parent.path, result.relativePath);
                const nextParent = replaceNode(parentResult.file, link.nodeId, { ...node, ref } as WorkflowNode);
                patched[link.depth] = { ...parent, state: { phase: "open", result: { ...parentResult, file: nextParent } } };
              }
            }
            return patched;
          });
          return { status: "created", path: result.relativePath };
        })
        .catch((error: unknown): SaveNewFileResult => {
          // A `412` on a no-precondition create means the path already exists — the dialog's "choose
          // another name", not the stale-write conflict `save` shows. Drop the transient saving phase back
          // to idle: the collision is the dialog's to surface, not the toolbar's.
          if (error instanceof PathApiError && error.status === 412) {
            setSaveState({ phase: "idle" });
            return { status: "exists" };
          }
          const message = errorMessage(error);
          setSaveState({ phase: "error", message });
          return { status: "error", message };
        });
    },
    [client],
  );

  // Open the initial deep-link once the registry is ready. Guarded so it fires once, not on every
  // registry re-render.
  const openedInitial = useRef(false);
  useEffect(() => {
    if (registry.phase === "ready" && initialPath && !openedInitial.current) {
      openedInitial.current = true;
      open(initialPath);
    }
  }, [registry, initialPath, open]);

  return { registry, frames, activeIndex, open, newFile, descend, descendNewUnbound, goTo, applyEdit, undo, redo, save, saveNewFile, reloadActive, saveState };
}
