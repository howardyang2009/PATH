import { useEffect, useMemo, useRef, useState } from "react";
import type { PathApiClient, TemplateSummary, WireStepPlugin } from "@path/client-core";
import type { WorkflowFile } from "@path/schema";
import { AppShell } from "./app-shell.js";
import { Canvas } from "./canvas.js";
import { EditingToolbar, ModeSwitch, TemplateFileName } from "./editing-toolbar.js";
import { dirnameOf, NewFileDialog } from "./new-file-dialog.js";
import { OpenWorkflowDialog } from "./open-existing-dialog.js";
import { OpenTemplateDialog } from "./open-template-dialog.js";
import { Palette } from "./palette.js";
import { PropertiesPane } from "./properties-pane.js";
import { RefTargetDialog } from "./ref-target-dialog.js";
import { SaveTemplateAsDialog } from "./save-template-as-dialog.js";
import { SelectionProvider } from "./selection-context.js";
import { RunDock } from "./run/run-dock.js";
import { RunProjectionProvider } from "./run/run-projection.js";
import { useRunWatch } from "./run/use-run-watch.js";
import { useEditLeases } from "./use-edit-leases.js";
import { useWorkflowDiscovery } from "./discovery.js";
import { useFileProblems } from "./use-file-problems.js";
import { useTemplateList } from "./template-list.js";
import { useArmed } from "./use-armed.js";
import { useRefAuthoring } from "./use-ref-authoring.js";
import { frameCanRedo, frameCanUndo, frameDirty, openedResultOf, useOpenFile } from "./use-open-file.js";

/** The workflow-level fields of `file` that hold a value — what a save as step-template drops. */
function workflowLevelFields(file: WorkflowFile): string[] {
  const filled = (value: object | undefined): boolean => value !== undefined && Object.keys(value).length > 0;
  return (["input", "output", "config", "worker_defaults"] as const).filter((key) => filled(file[key]));
}

/**
 * The Designer app: the pinned shell with the palette in the left rail, the node canvas at the centre,
 * and (from #369) the properties pane at the right. The palette arms a kind, the canvas opens only the
 * grammar-legal sockets and commits structure edits, a single-click on a node selects it, and the pane
 * edits the selected node's content (name, id, kind fields, worker) or — on an empty-canvas click — the
 * file's own properties. The run dock reuses the Viewer's run read panels (ADR 0031); the authoring
 * shell stays Designer-only.
 *
 * `initialPath` is the file to open on load — the deep-link `?path=`. Omitted, the canvas shows its
 * empty affordance. The **armed** value (the palette selection, `useArmed`) and the **selected id**
 * (what the pane edits) both live here, above the canvas and the pane that read them.
 */
export function App({ client, initialPath }: { client: PathApiClient; initialPath?: string }): JSX.Element {
  const session = useOpenFile(client, initialPath);
  const arming = useArmed(client);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The first-save dialog for a from-scratch buffer (#390). Opened by the toolbar's Save when the active
  // frame holds no path yet; the dialog decides the path, then closes on a successful create.
  const [newFileOpen, setNewFileOpen] = useState(false);
  // The open-existing picker (#254). Opened from the empty-canvas affordance or the toolbar; a choice
  // opens that discovered workflow as a fresh root through `session.open`, then closes the dialog.
  const [openExistingOpen, setOpenExistingOpen] = useState(false);
  // Template mode's save dialogs: a new template's first save, or a Save as… copy of an opened template
  // (#580). Workflow mode's Save as… (`"workflow-copy"`) writes the open workflow to a new file.
  const [saveAsDialog, setSaveAsDialog] = useState<"new-template" | "template" | "workflow-copy" | null>(null);
  // Template mode's Open… picker.
  const [openTemplateOpen, setOpenTemplateOpen] = useState(false);
  const plugins: WireStepPlugin[] = session.registry.phase === "ready" ? session.registry.plugins : [];

  const active = session.frames[session.activeIndex];
  // A from-scratch buffer carries `path: null`; fold it to `undefined` so the one "no path yet" state
  // (no frame, or a never-saved buffer) reads uniformly here — the toolbar, lease, launch, and the
  // first-save dialog all branch on the single `activePath === undefined`.
  const activePath = active?.path ?? undefined;
  // Author mode (#580): the active frame is a `*.workflow-template.json` source, saved by template id.
  const activeTemplate = active?.template;
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

  // The nested-`workflow`-ref authoring flow (#391), behind one seam (`useRefAuthoring`): the in-flight node,
  // the reference-existing edit, and the create-new descent. The pane and canvas both open it through the one
  // `onAuthorRef` handle; the chooser renders from `refAuthoring.target`.
  const refAuthoring = useRefAuthoring(session, openedFile, activePath);

  // Workflow discovery, loaded once for the whole surface (`discovery.ts`): the problems pass, the
  // open-existing picker, the first-save directory list and the ref-target picker all project this one
  // snapshot, so a save that writes a file (or a scan that lands mid-dialog) reads the same everywhere.
  const discovery = useWorkflowDiscovery(client, session.saveState.phase);
  // Re-listed after each save, so a Save-As template shows up in the palette (#580).
  const templateList = useTemplateList(client, session.saveState.phase);

  // The active file's cross-node problem pass (#388, #392), behind one seam (`useFileProblems`): it projects
  // discovery into the dangling-ref lookup and derives the whole-file walk once, shared by its two readers —
  // the canvas markers/panel and the launch button's warning count — so the two cannot disagree.
  const problems = useFileProblems(openedFile, activePath, discovery);
  // Launch is **badged, not blocked**: the count rides the launch button so the author runs knowingly (a
  // saved-with-warnings file is clean).
  const warningCount = problems.length;

  // Every door that replaces the stack (New, Open…, a mode switch, a template double-click) asks first
  // when any frame on the stack has unsaved edits.
  const confirmDiscard = (): boolean =>
    !session.frames.some((frame) => frameDirty(frame)) || window.confirm("Discard unsaved changes?");
  const inTemplateMode = session.mode === "template";
  const onNew = (): void => {
    if (!confirmDiscard()) return;
    if (inTemplateMode) session.newTemplate();
    else session.newFile();
  };
  const onOpen = (): void => (inTemplateMode ? setOpenTemplateOpen(true) : setOpenExistingOpen(true));
  // Open a template's own source in template mode (#580): from a palette-card double-click or the picker.
  const openTemplate = (template: TemplateSummary): void => {
    if (template.id === null || !confirmDiscard()) return;
    // The double-click's own single clicks armed or selected this card; disarm so a template read still
    // in flight is dropped instead of landing after the open.
    arming.arm(null);
    session.openTemplate({
      id: template.id,
      kind: template.kind,
      name: template.name,
      description: template.description,
      readOnly: template.read_only,
    });
  };

  // Open a discovered workflow as a fresh root (#254). `session.open` discards the current stack and its
  // per-file leases, so the selection resets through the active-frame effect above. Close the picker.
  const openExisting = (path: string): void => {
    setOpenExistingOpen(false);
    if (confirmDiscard()) session.open(path);
  };

  // The run surfaces (#372), gathered into one module (`useRunWatch`): the watched root run, the run inside
  // its tree, the reload nonce, the single `useRunView` connection, and the select/launch/resume/delete
  // transitions. The App reads its derived values and wires its transitions onto the run dock.
  // Key the run-watch on the **root** frame's workflow id, not the active file's. A `workflow`-ref descent
  // (or a pop) changes the active file but keeps the same watched root run — its tree spans the nested
  // workflows and projects onto each descent crumb. Only a fresh `session.open` swaps the root frame, and
  // that is the one transition where the watched run belongs to a workflow no longer open (#254).
  const rootWorkflowId = openedResultOf(session.frames[0])?.file.id ?? null;
  const run = useRunWatch(client, rootWorkflowId);

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
      modeSwitch={
        <ModeSwitch
          mode={session.mode}
          onSwitch={(mode) => {
            if (confirmDiscard()) session.switchMode(mode);
          }}
        />
      }
      // Template mode always names the file being edited, centred in the top bar.
      title={inTemplateMode && openedResult ? <TemplateFileName template={activeTemplate ?? null} /> : undefined}
      toolbar={
        session.registry.phase === "ready" ? (
          <EditingToolbar
            onNew={onNew}
            onOpen={onOpen}
            hasFile={openedResult !== null}
            saveState={session.saveState}
            dirty={dirty}
            canUndo={canUndo}
            canRedo={canRedo}
            onUndo={undo}
            onRedo={redo}
            // A from-scratch buffer (no path) has no on-disk file yet: Save opens the first-save dialog
            // instead of overwriting — the new-template dialog in template mode. A saved frame saves in
            // place through the write route, and a template source (#580) writes back to its template by id.
            onSave={
              activePath || activeTemplate
                ? session.save
                : inTemplateMode
                  ? () => setSaveAsDialog("new-template")
                  : () => setNewFileOpen(true)
            }
            // Save as…: a copy to a new workflow file, a copy to a new template, or (for a new template not
            // saved yet) its first save.
            onSaveAs={() => setSaveAsDialog(inTemplateMode ? (activeTemplate ? "template" : "new-template") : "workflow-copy")}
            onReload={session.reloadActive}
            lease={activePath ? leases.get(activePath) : undefined}
            onTakeover={() => activePath && takeover(activePath)}
            onReacquire={() => activePath && reacquire(activePath)}
          />
        ) : undefined
      }
      palette={
        <Palette
          plugins={plugins}
          templateList={templateList}
          arming={arming}
          canvasEmpty={session.canvasEmpty}
          placeWorkflowInstance={session.placeWorkflowInstance}
          // In template mode, a double-click opens the template source, discarding the current stack.
          onEditTemplate={openTemplate}
          canEditTemplates={inTemplateMode}
        />
      }
      canvas={
        <RunProjectionProvider runs={run.runsForProjection}>
          <SelectionProvider value={{ selectedId, onSelect: setSelectedId }}>
            <Canvas
              session={session}
              plugins={plugins}
              armed={arming.armed}
              onArm={arming.arm}
              problems={problems}
              onNew={onNew}
              onOpenExisting={onOpen}
              // Double-click an unset `workflow` block to author its target — the same chooser the pane's
              // "Add a workflow reference" opens, offered only when the parent has a path for a relative ref.
              onAuthorRef={refAuthoring.onAuthorRef}
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
            onAddRefTarget={refAuthoring.onAuthorRef}
          />
        ) : (
          <div className="pane pane-idle">
            <p className="pane-hint">Open a {inTemplateMode ? "template" : "workflow"} and select a node to edit it.</p>
          </div>
        )
      }
      runDock={
        <RunDock
          client={client}
          disabledReason={inTemplateMode ? "Templates do not run. Switch to Workflow mode to run a workflow." : undefined}
          plugins={plugins}
          // An unwritten buffer has no file on disk for the server to load, so it cannot launch (#391 AC:
          // "no launch until its first save"). A create-new child carries a pre-assigned path, so gate the
          // launch handle on `written`, not on the path — an unwritten child reads as unsaved, like a
          // from-scratch root, rather than relying on its (always-dirty) buffer to block launch.
          workflowPath={active?.written ? activePath ?? null : null}
          workflowId={openedFile?.id ?? null}
          rootFile={openedFile}
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
    {newFileOpen && openedFile && activePath === undefined && !activeTemplate ? (
      <NewFileDialog
        discovery={discovery}
        workflowName={openedFile.name}
        create={session.saveNewFile}
        onCreated={() => setNewFileOpen(false)}
        onCancel={() => setNewFileOpen(false)}
      />
    ) : null}
    {/* Template mode's save doors. A new template's first save picks its kind, name and description; Save
        as… (#580) names a copy of the opened template. A template saves only as a template: a workflow is
        made from one in workflow mode, by selecting its card into an empty canvas. */}
    {saveAsDialog === "new-template" && openedFile && !activeTemplate ? (
      <SaveTemplateAsDialog
        source={null}
        create={({ kind, name, description }) => session.saveNewTemplate(kind, name, description)}
        onCreated={() => setSaveAsDialog(null)}
        onCancel={() => setSaveAsDialog(null)}
      />
    ) : null}
    {saveAsDialog === "template" && activeTemplate ? (
      <SaveTemplateAsDialog
        source={activeTemplate}
        droppedFields={openedFile ? workflowLevelFields(openedFile) : []}
        create={({ kind, name, description }) => session.saveAsTemplate(kind, name, description)}
        onCreated={() => setSaveAsDialog(null)}
        onCancel={() => setSaveAsDialog(null)}
      />
    ) : null}
    {saveAsDialog === "workflow-copy" && !inTemplateMode && openedFile ? (
      <NewFileDialog
        discovery={discovery}
        title="Save workflow as"
        workflowName={`${openedFile.name}-copy`}
        initialDirectory={activePath ? dirnameOf(activePath) : ""}
        create={session.saveWorkflowAs}
        onCreated={() => setSaveAsDialog(null)}
        onCancel={() => setSaveAsDialog(null)}
      />
    ) : null}
    {/* The open-existing picker (#254): choose a discovered workflow and open it as a fresh root. Shown
        above the shell from either the empty-canvas affordance or the toolbar's Open button. */}
    {openExistingOpen ? (
      <OpenWorkflowDialog discovery={discovery} onOpen={openExisting} onCancel={() => setOpenExistingOpen(false)} />
    ) : null}
    {openTemplateOpen ? (
      <OpenTemplateDialog
        templateList={templateList}
        onOpen={(template) => {
          setOpenTemplateOpen(false);
          openTemplate(template);
        }}
        onCancel={() => setOpenTemplateOpen(false)}
      />
    ) : null}
    {/* The ref-target chooser (#391): reference an existing workflow, or create a new one and descend into
        its fresh, unwritten child buffer. Shown only while an empty `workflow` node awaits a target. */}
    {refAuthoring.target !== null ? (
      <RefTargetDialog
        discovery={discovery}
        excludePath={refAuthoring.target.excludePath}
        onPickExisting={refAuthoring.pickExisting}
        onCreateNew={refAuthoring.createNew}
        onCancel={refAuthoring.cancel}
      />
    ) : null}
    </>
  );
}
