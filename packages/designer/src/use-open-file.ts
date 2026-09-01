import { useCallback, useEffect, useRef, useState } from "react";
import type { PathApiClient, WireStepPlugin } from "@path/client-core";
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

/** One file on the navigation stack: its path, and where its fetch-and-open got to. */
export interface Frame {
  path: string;
  state: FrameState;
}

/** A frame is fetching, failed to fetch, or has an open outcome (which may itself be a legible refusal). */
export type FrameState =
  | { phase: "loading" }
  | { phase: "fetch-error"; message: string }
  | { phase: "open"; result: OpenResult };

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
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Fetch one file's raw bytes and run the open pipeline; a fetch failure (404, …) becomes a frame error. */
async function loadFrame(client: PathApiClient, path: string, plugins: WireStepPlugin[]): Promise<FrameState> {
  try {
    const raw = await client.getWorkflowFile(path);
    return { phase: "open", result: openWorkflowFile(raw.text, plugins) };
  } catch (error) {
    return { phase: "fetch-error", message: errorMessage(error) };
  }
}

export function useOpenFile(client: PathApiClient, initialPath?: string): OpenSession {
  const [registry, setRegistry] = useState<RegistryLoad>({ phase: "loading" });
  const [frames, setFrames] = useState<Frame[]>([]);

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
      void loadFrame(client, path, plugins).then((state) => {
        if (token !== loadToken.current) return;
        setFrames((prev) => {
          if (depth >= prev.length || prev[depth]?.path !== path) return prev;
          const next = prev.slice();
          next[depth] = { path, state };
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
      setFrames([{ path, state: { phase: "loading" } }]);
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
      setFrames((prev) => [...prev, { path, state: { phase: "loading" } }]);
      runLoad(path, depth, plugins);
    },
    [runLoad],
  );

  const goTo = useCallback((index: number): void => {
    // Any deeper in-flight load is now stale; bump the token so it cannot patch the truncated stack.
    loadToken.current++;
    setFrames((prev) => (index < 0 || index >= prev.length ? prev : prev.slice(0, index + 1)));
  }, []);

  const applyEdit = useCallback((next: WorkflowFile): void => {
    setFrames((prev) => {
      const depth = prev.length - 1;
      const frame = prev[depth];
      if (!frame || frame.state.phase !== "open" || frame.state.result.status !== "opened") return prev;
      const patched = prev.slice();
      patched[depth] = { ...frame, state: { phase: "open", result: { ...frame.state.result, file: next, edited: true } } };
      return patched;
    });
  }, []);

  // Open the initial deep-link once the registry is ready. Guarded so it fires once, not on every
  // registry re-render.
  const openedInitial = useRef(false);
  useEffect(() => {
    if (registry.phase === "ready" && initialPath && !openedInitial.current) {
      openedInitial.current = true;
      open(initialPath);
    }
  }, [registry, initialPath, open]);

  return { registry, frames, open, descend, goTo, applyEdit };
}
