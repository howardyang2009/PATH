import { useEffect, useMemo, useRef, useState } from "react";
import type { PathApiClient, WireStepPlugin } from "@path/client-core";
import type { WorkflowNode } from "@path/schema";
import { AppShell } from "./app-shell.js";
import { Canvas } from "./canvas.js";
import { EditingToolbar } from "./editing-toolbar.js";
import { findById, replaceNode } from "./edit-tree.js";
import { NewFileDialog } from "./new-file-dialog.js";
import { OpenWorkflowDialog } from "./open-existing-dialog.js";
import { Palette } from "./palette.js";
import { fileProblems, refLookupFor, type Problem } from "./problems.js";
import { PropertiesPane } from "./properties-pane.js";
import { RefTargetDialog } from "./ref-target-dialog.js";
import { relativeRefPath } from "./resolve-ref.js";
import { SelectionProvider } from "./selection-context.js";
import { RunDock } from "./run/run-dock.js";
import { RunProjectionProvider } from "./run/run-projection.js";
import { useRunWatch } from "./run/use-run-watch.js";
import { useEditLeases } from "./use-edit-leases.js";
import { frameCanRedo, frameCanUndo, frameDirty, openedResultOf, useOpenFile } from "./use-open-file.js";

/**
 * The Designer app: the pinned shell with the palette in the left rail, the node canvas at the centre,
 * and (from #369) the properties pane at the right. The palette arms a kind, the canvas opens only the
 * grammar-legal sockets and commits structure edits, a single-click on a node selects it, and the pane
 * edits the selected node's content (name, id, kind fields, worker) or — on an empty-canvas click — the
 * file's own properties. The run dock reuses the Viewer's run read panels (ADR 0031); the authoring
 * shell stays Designer-only.
 *
 * `initialPath` is the file to open on load — the deep-link `?path=`. Omitted, the canvas shows its
 * empty affordance. The **armed kind** (the palette selection) and the **selected id** (what the pane
 * edits) both live here, above the canvas and the pane that read them.
 */
export function App({ client, initialPath }: { client: PathApiClient; initialPath?: string }): JSX.Element {
  const session = useOpenFile(client, initialPath);
  const [armedKind, setArmedKind] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The first-save dialog for a from-scratch buffer (#390). Opened by the toolbar's Save when the active
  // frame holds no path yet; the dialog decides the path, then closes on a successful create.
  const [newFileOpen, setNewFileOpen] = useState(false);
  // The open-existing picker (#254). Opened from the empty-canvas affordance or the toolbar; a choice
  // opens that discovered workflow as a fresh root through `session.open`, then closes the dialog.
  const [openExistingOpen, setOpenExistingOpen] = useState(false);
  // The ref-target chooser (#391): the id of the empty `workflow` node whose target is being chosen, or
  // `null`. Opened from the pane's ref editor; a choice sets the parent ref (and, for create-new, descends
  // into a fresh child), then closes it.
  const [refTargetNode, setRefTargetNode] = useState<string | null>(null);
  const plugins: WireStepPlugin[] = session.registry.phase === "ready" ? session.registry.plugins : [];

  const active = session.frames[session.activeIndex];
  // A from-scratch buffer carries `path: null`; fold it to `undefined` so the one "no path yet" state
  // (no frame, or a never-saved buffer) reads uniformly here — the toolbar, lease, launch, and the
  // first-save dialog all branch on the single `activePath === undefined`.
  const activePath = active?.path ?? undefined;
  const depth = session.activeIndex;
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

  // The discovered-workflow path set (#392), the origin the dangling-`workflow`-ref check resolves against
  // (§ Nested `workflow`-ref creation). `null` until the first scan lands — an empty set reads as "no files
  // exist" and would flag every saved ref dangling for one frame, so the check is suppressed until then. A
  // fresh scan on mount and after every save transition: a create-new child's first save writes its file,
  // so re-reading discovery on the next `saved` clears the parent's dangling marker. Discovery is
  // best-effort — a failed scan leaves the last set, so a ref is not flagged dangling on a read blip.
  const [knownPaths, setKnownPaths] = useState<ReadonlySet<string> | null>(null);
  const savePhase = session.saveState.phase;
  useEffect(() => {
    let cancelled = false;
    client
      .listWorkflows()
      .then((discovered) => {
        if (!cancelled) setKnownPaths(new Set(discovered.workflows.map((wf) => wf.relative_path)));
      })
      .catch(() => {
        // Best-effort; keep the last known set rather than flag every ref dangling on a read blip.
      });
    return () => {
      cancelled = true;
    };
  }, [client, savePhase]);

  // The ref lookup for the active file (its own path resolves a relative ref; the discovered set says which
  // targets exist). `undefined` for a from-scratch root or before discovery loads, which skips the check.
  const refLookup = useMemo(() => refLookupFor(activePath, knownPaths), [activePath, knownPaths]);
  // The cross-node problem pass for the active file (#388, #392), derived **once** here and shared by its
  // two readers — the canvas markers/panel and the launch button's warning count — so the two cannot
  // disagree and the whole-file walk runs one time per render, not twice.
  const problems = useMemo<Problem[]>(() => (openedFile ? fileProblems(openedFile, refLookup) : []), [openedFile, refLookup]);
  // Launch is **badged, not blocked**: the count rides the launch button so the author runs knowingly (a
  // saved-with-warnings file is clean).
  const warningCount = problems.length;

  // ── Nested `workflow`-ref creation (#391) ────────────────────────────────────────────────────────
  // Set the empty `workflow` node's `ref` to reach `targetPath`. The stored ref is relative to the
  // referring file's directory (`relativeRefPath`), so this needs the parent's path — the chooser is
  // only offered when the active file has one.
  const fileWithNodeRef = (nodeId: string, targetPath: string) => {
    if (!openedFile || activePath === undefined) return null;
    const node = findById(openedFile.body, nodeId);
    if (!node || node.type !== "workflow") return null;
    const ref = relativeRefPath(activePath, targetPath);
    return replaceNode(openedFile, nodeId, { ...node, ref } as WorkflowNode);
  };
  // Reference-existing: point the ref at a discovered workflow and close.
  const pickExistingRef = (nodeId: string, targetPath: string): void => {
    const next = fileWithNodeRef(nodeId, targetPath);
    if (next) session.applyEdit(next);
    setRefTargetNode(null);
  };
  // Create-new: descend at once into a fresh, unwritten, path-less child linked back to this node. No path
  // is chosen here and no ref is set yet — the child's first save picks the path and back-fills the parent
  // ref from it (§ Nested `workflow`-ref creation), so authoring comes first and the ref follows the save.
  const createNewRef = (nodeId: string): void => {
    session.descendNewUnbound(nodeId);
    setRefTargetNode(null);
  };

  // Open a discovered workflow as a fresh root (#254). `session.open` discards the current stack and its
  // per-file leases, so the selection resets through the active-frame effect above. Close the picker.
  const openExisting = (path: string): void => {
    session.open(path);
    setOpenExistingOpen(false);
  };

  // The run surfaces (#372), gathered into one module (`useRunWatch`): the watched root run, the run inside
  // its tree, the reload nonce, the single `useRunView` connection, and the select/launch/resume/delete
  // transitions. The App reads its derived values and wires its transitions onto the run dock.
  const run = useRunWatch(client);

  // The lease is per file (ADR 0017): acquire one for every *opened* frame on the stack, so a
  // `workflow`-ref descent holds a second, independently-beating lease under the same session, and a
  // frame that only failed to open (a 404) or a brand-new, never-saved buffer (no path) takes none.
  const leasedPaths = useMemo(
    () =>
      session.frames
        // An unwritten frame (a from-scratch root, or a create-new child before its first save, #391) takes
        // no lease — the from-scratch rule — so a lease is held only for an opened, written, path-bearing frame.
        .filter((frame) => openedResultOf(frame) !== null && frame.written && frame.path !== null)
        .map((frame) => frame.path as string),
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
    <>
    <AppShell
      toolbar={
        openedResult ? (
          <EditingToolbar
            saveState={session.saveState}
            dirty={dirty}
            canUndo={canUndo}
            canRedo={canRedo}
            onUndo={undo}
            onRedo={redo}
            // A from-scratch buffer (no path) has no on-disk file yet: Save opens the first-save dialog
            // instead of overwriting. A saved frame saves in place through the write route.
            onSave={activePath ? session.save : () => setNewFileOpen(true)}
            onOpenExisting={() => setOpenExistingOpen(true)}
            onReload={session.reloadActive}
            lease={activePath ? leases.get(activePath) : undefined}
            onTakeover={() => activePath && takeover(activePath)}
            onReacquire={() => activePath && reacquire(activePath)}
          />
        ) : undefined
      }
      palette={<Palette plugins={plugins} armedKind={armedKind} onArm={setArmedKind} />}
      canvas={
        <RunProjectionProvider runs={run.runsForProjection}>
          <SelectionProvider value={{ selectedId, onSelect: setSelectedId }}>
            <Canvas
              session={session}
              plugins={plugins}
              armedKind={armedKind}
              onArm={setArmedKind}
              problems={problems}
              onOpenExisting={() => setOpenExistingOpen(true)}
              // Double-click an unset `workflow` block to author its target — the same chooser the pane's
              // "Add a workflow reference" opens, offered only when the parent has a path for a relative ref.
              onAuthorRef={activePath !== undefined ? setRefTargetNode : undefined}
              workflowRunStatus={run.workflowRunStatus}
            />
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
            // The ref-target chooser needs the parent's path to store a relative ref, so offer it only for
            // a file that has one (#391); a from-scratch root falls back to the plain path field.
            onAddRefTarget={activePath !== undefined ? setRefTargetNode : undefined}
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
          // An unwritten buffer has no file on disk for the server to load, so it cannot launch (#391 AC:
          // "no launch until its first save"). A create-new child carries a pre-assigned path, so gate the
          // launch handle on `written`, not on the path — an unwritten child reads as unsaved, like a
          // from-scratch root, rather than relying on its (always-dirty) buffer to block launch.
          workflowPath={active?.written ? activePath ?? null : null}
          workflowId={openedFile?.id ?? null}
          dirty={dirty}
          warningCount={warningCount}
          load={run.load}
          rootRunId={run.rootRunId}
          selectedRunId={run.selectedRunId}
          onSelectRootRun={run.selectRootRun}
          onSelectRun={run.selectRun}
          onLaunched={run.watchNewRun}
          onResumed={run.watchNewRun}
          onDeleted={run.onDeleted}
          reloadNonce={run.reloadNonce}
        />
      }
    />
    {/* The first-save dialog rides above the shell, shown only for a from-scratch buffer (no path) whose
        author asked to save. It decides the path; a successful create closes it and the frame is saved. */}
    {newFileOpen && openedFile && activePath === undefined ? (
      <NewFileDialog
        client={client}
        workflowName={openedFile.name}
        create={session.saveNewFile}
        onCreated={() => setNewFileOpen(false)}
        onCancel={() => setNewFileOpen(false)}
      />
    ) : null}
    {/* The open-existing picker (#254): choose a discovered workflow and open it as a fresh root. Shown
        above the shell from either the empty-canvas affordance or the toolbar's Open button. */}
    {openExistingOpen ? (
      <OpenWorkflowDialog client={client} onOpen={openExisting} onCancel={() => setOpenExistingOpen(false)} />
    ) : null}
    {/* The ref-target chooser (#391): reference an existing workflow, or create a new one and descend into
        its fresh, unwritten child buffer. Shown only while an empty `workflow` node awaits a target. */}
    {refTargetNode !== null && activePath !== undefined ? (
      <RefTargetDialog
        client={client}
        excludePath={activePath}
        onPickExisting={(targetPath) => pickExistingRef(refTargetNode, targetPath)}
        onCreateNew={() => createNewRef(refTargetNode)}
        onCancel={() => setRefTargetNode(null)}
      />
    ) : null}
    </>
  );
}
