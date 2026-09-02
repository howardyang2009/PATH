import { useEffect, useMemo, useRef, useState } from "react";
import type { PathApiClient, WireStepPlugin } from "@path/client-core";
import { AppShell } from "./app-shell.js";
import { Canvas } from "./canvas.js";
import { EditingToolbar } from "./editing-toolbar.js";
import { Palette } from "./palette.js";
import { fileProblems } from "./problems.js";
import { PropertiesPane } from "./properties-pane.js";
import { SelectionProvider } from "./selection-context.js";
import { RunDock } from "./run/run-dock.js";
import { RunProjectionProvider } from "./run/run-projection.js";
import { useRunView } from "./run/use-run-view.js";
import { useEditLeases } from "./use-edit-leases.js";
import { frameCanRedo, frameCanUndo, frameDirty, openedResultOf, useOpenFile } from "./use-open-file.js";

/**
 * The Designer app: the pinned shell with the palette in the left rail, the node canvas at the centre,
 * and (from #369) the properties pane at the right. The palette arms a kind, the canvas opens only the
 * grammar-legal sockets and commits structure edits, a single-click on a node selects it, and the pane
 * edits the selected node's content (name, id, kind fields, worker) or — on an empty-canvas click — the
 * file's own properties. Save and run stay later tickets. It never imports the Viewer (ADR 0028).
 *
 * `initialPath` is the file to open on load — the deep-link `?path=`. Omitted, the canvas shows its
 * empty affordance. The **armed kind** (the palette selection) and the **selected id** (what the pane
 * edits) both live here, above the canvas and the pane that read them.
 */
export function App({ client, initialPath }: { client: PathApiClient; initialPath?: string }): JSX.Element {
  const session = useOpenFile(client, initialPath);
  const [armedKind, setArmedKind] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const plugins: WireStepPlugin[] = session.registry.phase === "ready" ? session.registry.plugins : [];

  const active = session.frames[session.frames.length - 1];
  const activePath = active?.path;
  const depth = session.frames.length;
  // Switching the active file (descend, pop, or open a different one) deselects — the previous file's
  // node ids mean nothing here. The *first* population (no file → the initial file) is not a switch:
  // nothing was selected yet, so resetting then is a no-op that only races an interaction landing right
  // as the file opens. So track the previous frame and reset only on a genuine change between two states.
  const prevFrame = useRef<{ path?: string; depth: number } | null>(null);
  useEffect(() => {
    const prev = prevFrame.current;
    // Reset only when we were already on a real file and it changed — never on the first population from
    // "no file" (`prev.path` undefined), which is the transition that raced a just-made selection.
    if (prev !== null && prev.path !== undefined && (prev.path !== activePath || prev.depth !== depth)) {
      setSelectedId(null);
    }
    prevFrame.current = { path: activePath, depth };
  }, [activePath, depth]);

  const openedResult = openedResultOf(active);
  const openedFile = openedResult?.file ?? null;
  // The soft cross-node warning count for the open file (#388). Launch is **badged, not blocked**: the
  // count rides the launch button so the author runs knowingly (a saved-with-warnings file is clean).
  const warningCount = useMemo(() => (openedFile ? fileProblems(openedFile).length : 0), [openedFile]);

  // The run surfaces (#372). One connection, owned here, feeds both the canvas projection and the
  // inspector — the two are views of one live snapshot, and a second connection would tell the same
  // story a beat apart. Selection (the watched root run, and the run inside its tree) lives here too.
  const [selectedRootRunId, setSelectedRootRunId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runsReloadNonce, setRunsReloadNonce] = useState(0);
  const runLoad = useRunView(client, selectedRootRunId);
  const runsForProjection = runLoad.phase === "ready" ? runLoad.value.runs : null;

  // Switching root run drops the node selection: a run id from the previous tree names nothing in the
  // new one.
  const selectRootRun = (rootRunId: string): void => {
    setSelectedRootRunId(rootRunId);
    setSelectedRunId(null);
  };

  // A launch/resume is the same transition as a click — watch the new run — plus a nudge so the list
  // re-reads and shows the new row now, not at the next periodic tick.
  const watchNewRun = (rootRunId: string): void => {
    selectRootRun(rootRunId);
    setRunsReloadNonce((nonce) => nonce + 1);
  };

  // The lease is per file (ADR 0017): acquire one for every *opened* frame on the stack, so a
  // `workflow`-ref descent holds a second, independently-beating lease under the same session, and a
  // frame that only failed to open (a 404) or a brand-new, never-saved buffer (no path) takes none.
  const leasedPaths = useMemo(
    () => session.frames.filter((frame) => openedResultOf(frame) !== null).map((frame) => frame.path),
    [session.frames],
  );
  const { leases, takeover, reacquire } = useEditLeases(client, leasedPaths);
  // Dirty is content-equality against the active frame's baseline (ADR 0030), the same fact launch and
  // Save gate on — not a mutation flag. `active` is the frame the buffer and its baseline live on.
  const dirty = frameDirty(active);
  // The undo/redo affordances read the active frame's own stack (#389, per-file). `undo`/`redo` are
  // stable session callbacks, so the keyboard peer below re-subscribes only when the enablement flips.
  const canUndo = frameCanUndo(active);
  const canRedo = frameCanRedo(active);
  const { undo, redo } = session;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // Editing-key parity with the toolbar buttons: ⌘/Ctrl+Z undoes, ⌘/Ctrl+Shift+Z or Ctrl+Y redoes.
      // Leave a text field's own native undo alone — a keystroke run is a field concern until it blurs.
      const key = event.key.toLowerCase();
      if (!(event.metaKey || event.ctrlKey) || (key !== "z" && key !== "y")) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const wantsRedo = key === "y" || (key === "z" && event.shiftKey);
      if (wantsRedo) {
        if (canRedo) {
          event.preventDefault();
          redo();
        }
      } else if (canUndo) {
        event.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canUndo, canRedo, undo, redo]);

  return (
    <AppShell
      toolbar={
        openedResult && activePath ? (
          <EditingToolbar
            saveState={session.saveState}
            dirty={dirty}
            canUndo={canUndo}
            canRedo={canRedo}
            onUndo={undo}
            onRedo={redo}
            onSave={session.save}
            onReload={session.reloadActive}
            lease={leases.get(activePath)}
            onTakeover={() => takeover(activePath)}
            onReacquire={() => reacquire(activePath)}
          />
        ) : undefined
      }
      palette={<Palette plugins={plugins} armedKind={armedKind} onArm={setArmedKind} />}
      canvas={
        <RunProjectionProvider runs={runsForProjection}>
          <SelectionProvider value={{ selectedId, onSelect: setSelectedId }}>
            <Canvas session={session} plugins={plugins} armedKind={armedKind} onArm={setArmedKind} />
          </SelectionProvider>
        </RunProjectionProvider>
      }
      pane={
        openedFile ? (
          <PropertiesPane
            file={openedFile}
            selectedId={selectedId}
            plugins={plugins}
            applyEdit={session.applyEdit}
            onReselect={setSelectedId}
          />
        ) : (
          <div className="pane pane-idle">
            <p className="pane-hint">Open a workflow and select a node to edit it.</p>
          </div>
        )
      }
      runDock={
        <RunDock
          client={client}
          workflowPath={activePath ?? null}
          workflowId={openedFile?.id ?? null}
          dirty={dirty}
          warningCount={warningCount}
          load={runLoad}
          rootRunId={selectedRootRunId}
          selectedRunId={selectedRunId}
          onSelectRootRun={selectRootRun}
          onSelectRun={setSelectedRunId}
          onLaunched={watchNewRun}
          onResumed={watchNewRun}
          reloadNonce={runsReloadNonce}
        />
      }
    />
  );
}
