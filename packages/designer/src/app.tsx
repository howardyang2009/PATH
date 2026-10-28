import type { PathApiClient, WireStepPlugin } from "@path/client-core";
import { useMessage } from "@path/i18n/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { AppShell } from "./app-shell.js";
import { useAuthoredFiles } from "./authored-files.js";
import { Canvas } from "./canvas.js";
import {
  type Dialog,
  type DialogView,
  dialogOnSave,
  NO_DIALOG,
  openSaveAs,
  resolvedDialog,
  saveAsDialog,
} from "./dialog-flow.js";
import { discoveredMaxFileBytes } from "./discovery.js";
import { documentPolicy } from "./document.js";
import { useDocumentDoors } from "./document-doors.js";
import { downloadFailure, downloadFile } from "./download-file.js";
import {
  EditingToolbar,
  FileStatus,
  ModeSwitch,
  TemplateFileName,
  WorkflowFileName,
} from "./editing-toolbar.js";
import { editorChrome } from "./editor-chrome.js";
import { dirnameOf, NewFileDialog } from "./new-file-dialog.js";
import { OpenWorkflowDialog } from "./open-existing-dialog.js";
import { OpenTemplateDialog } from "./open-template-dialog.js";
import { Palette } from "./palette.js";
import { PropertiesPane } from "./pane/properties-pane.js";
import { RefTargetDialog } from "./ref-target-dialog.js";
import { RunDock } from "./run/run-dock.js";
import { RunProjectionProvider } from "./run/run-projection.js";
import { useRunWatch } from "./run/use-run-watch.js";
import { SaveAsChoiceDialog } from "./save-as-choice-dialog.js";
import { SaveTemplateAsDialog } from "./save-template-as-dialog.js";
import { SelectionProvider } from "./selection-context.js";
import { droppedWorkflowFields } from "./session-reducer.js";
import { UploadCopyDialog } from "./upload-copy-dialog.js";
import { UploadDialog } from "./upload-dialog.js";
import { useArmed } from "./use-armed.js";
import { useEditLeases } from "./use-edit-leases.js";
import { useFileProblems } from "./use-file-problems.js";
import { frameDirty, frameHasUnsavedWork, openedResultOf, useOpenFile } from "./use-open-file.js";
import { useRefAuthoring } from "./use-ref-authoring.js";

/** The Designer app: palette rail, canvas, and properties pane. `initialPath` is the deep-link
 * `?path=`; the armed palette value and the selected id both live here, above the canvas and the
 * pane that read them. */
export function App({
  client,
  initialPath,
}: {
  client: PathApiClient;
  initialPath?: string;
}): JSX.Element {
  const t = useTranslations("designer.app");
  const renderMessage = useMessage();
  const session = useOpenFile(client, initialPath);
  const arming = useArmed(client);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The one open dialog (`dialog-flow.ts`): the whole-file pickers and the Save as… doors. Every
  // transition names a dialog; the render below reads the resolved one.
  const [dialog, setDialog] = useState<Dialog>(NO_DIALOG);
  const closeDialog = (): void => setDialog(NO_DIALOG);
  const plugins: WireStepPlugin[] =
    session.registry.phase === "ready" ? session.registry.value : [];

  const active = session.frames[session.activeIndex];
  // A from-scratch buffer carries `path: null`; fold it to `undefined` so the toolbar, lease,
  // launch, and the first-save dialog all branch on the single "no path yet" state.
  const activePath = active?.path ?? undefined;
  // Author mode: the active frame is a `*.step-template.json` source, saved by template id.
  const activeTemplate = active?.template;
  const depth = session.activeIndex;
  // Switching the active file (descend, pop, or open a different one) deselects — the previous
  // file's node ids mean nothing here. The first population (no file → the initial file) is not a
  // switch.
  const prevFrame = useRef<{ path?: string; depth: number } | null>(null);
  useEffect(() => {
    const prev = prevFrame.current;
    // Reset only on a genuine change between two real files — never on the first population from
    // "no file", the transition that raced a just-made selection.
    if (
      prev !== null &&
      prev.path !== undefined &&
      (prev.path !== activePath || prev.depth !== depth)
    ) {
      setSelectedId(null);
    }
    prevFrame.current = { path: activePath, depth };
  }, [activePath, depth]);

  const openedResult = openedResultOf(active);
  const openedFile = openedResult?.file ?? null;

  // The nested-`workflow`-ref authoring flow, behind one seam (`useRefAuthoring`): the in-flight
  // node, the reference-existing edit, and the create-new descent. Pane and canvas open it through
  // one `onAuthorRef`.
  const refAuthoring = useRefAuthoring(session, openedFile, activePath);

  // Workflow discovery, loaded once for the whole surface: the problems pass, the open-existing
  // picker, the first-save directory list, and the ref-target picker all project this one snapshot,
  // so a save that writes a file (or a scan landing mid-dialog) reads the same everywhere.
  // The template list rides the same scans, so a Save-As template shows up in the palette.
  const authored = useAuthoredFiles(client, session.saveState.phase);
  const { discovery, templateList } = authored;

  // The active file's cross-node problem pass, behind one seam (`useFileProblems`), shared by its
  // two readers — the canvas markers/panel and the launch button's warning count — so they cannot
  // disagree.
  const problems = useFileProblems(openedFile, activePath, discovery);
  // Launch is **badged, not blocked**: the count rides the launch button so the author runs
  // knowingly.
  const warningCount = problems.length;

  const inTemplateMode = session.mode === "template";
  const onOpen = (): void =>
    setDialog(inTemplateMode ? { kind: "open-template" } : { kind: "open-workflow" });

  // The run surfaces, gathered into one module (`useRunWatch`); the App reads its derived values
  // and wires its transitions onto the run dock. Key the run-watch on the **root** frame's workflow
  // id, not the active file's: a `workflow`-ref descent keeps the same watched root run, and only a
  // fresh `session.open` swaps the root frame — the one transition where the watched run's workflow
  // is gone.
  const rootWorkflowId = openedResultOf(session.frames[0])?.file.id ?? null;
  const run = useRunWatch(client, rootWorkflowId);

  // The lease is per file: acquire one for every *opened* frame on the stack, so a `workflow`-ref
  // descent holds a second, independently-beating lease; a frame that only failed to open or a
  // never-saved buffer takes none. The document policy below picks the doors and the leased paths
  // from the session alone. A read-only file takes none: the Server leases only to its writer.
  const policy = documentPolicy(session, discovery);
  const { deletePlan, downloadPlan, leasedPaths } = policy;
  const { sessionId, leases, takeover, reacquire } = useEditLeases(client, leasedPaths);
  // Delete removes the root file from disk: always confirmed, since it cannot be undone.
  const onDelete = (): void => {
    if (!deletePlan) return;
    const unsaved = String(session.frames.some((frame) => frameHasUnsavedWork(frame)));
    const question =
      deletePlan.kind === "template"
        ? t("deleteTemplate", { name: deletePlan.name, unsaved })
        : t("deleteWorkflow", { path: deletePlan.path, unsaved });
    if (window.confirm(question)) session.deleteActive(sessionId);
  };
  // Dirty is content-equality against the active frame's baseline, the same fact launch and Save
  // gate on — not a mutation flag. `active` is the frame the buffer and its baseline live on.
  const dirty = frameDirty(active);
  // Download saves the active frame's file as it is on disk, so a dirty buffer is confirmed first.
  const onDownload = (): void => {
    if (!downloadPlan) return;
    if (dirty && !window.confirm(t("downloadDirty"))) return;
    downloadFile(client, downloadPlan).catch((error: unknown) =>
      window.alert(
        t("couldNotDownload", { message: downloadFailure(error).map(renderMessage).join("\n") }),
      ),
    );
  };
  // Every door that replaces the stack (New, Open, Copy, the mode switch, Upload) asks first when
  // a frame has unsaved edits, and disarms the palette before it opens.
  const doors = useDocumentDoors(
    {
      client,
      session,
      disarm: () => arming.arm(null),
      rescan: authored.rescan,
      prompts: {
        discardUnsaved: () => window.confirm(t("discardUnsaved")),
        replaceUpload: (name) => window.confirm(t("uploadReplace", { name })),
        uploadRefused: (message) =>
          window.alert(t("couldNotUpload", { message: renderMessage(message) })),
      },
    },
    { sessionId, heldPaths: leasedPaths },
  );
  const { upload } = doors;
  const uploadInput = useRef<HTMLInputElement>(null);
  // What the open dialog is allowed to be, and what a Save opens: a from-scratch buffer (no path)
  // takes its first-save door rather than overwriting; a saved frame saves in place, and a template
  // source writes back to its template by id.
  const dialogView: DialogView = {
    mode: session.mode,
    hasOpenFile: openedFile !== null,
    activeTemplate: activeTemplate !== undefined,
    scratch: activePath === undefined,
  };
  const openDialog = resolvedDialog(dialog, dialogView);
  // The save-as intent behind each template save door; the dialog's resolution already checked
  // the active frame fits it.
  const templateSave =
    openDialog.kind !== "save-as"
      ? null
      : openDialog.dialog.kind === "new-template"
        ? ({ kind: "new-template" } as const)
        : openDialog.dialog.kind === "template-copy"
          ? ({ kind: "template-copy" } as const)
          : openDialog.dialog.kind === "workflow-template"
            ? ({ kind: "workflow-as-template" } as const)
            : null;
  // A first-save door holds the identity the write needs; a buffer that already has one saves in
  // place. Memoized so the ⌘S listener re-subscribes only when the gate or the door flips.
  const onSave = useCallback((): void => {
    const firstSave = dialogOnSave(policy.saveDoor);
    if (firstSave.kind === "none") session.save();
    else setDialog(firstSave);
  }, [policy.saveDoor, session.save]);
  // The toolbar's whole capability surface, derived once: the Save button, ⌘S and the two keyboard
  // peers below all read this one value.
  const chrome = editorChrome(session, policy, activePath ? leases.get(activePath) : undefined);
  useEffect(() => {
    // ⌘/Ctrl+S runs the Save button, from any focus. It always blocks the browser's own Save Page.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      if (chrome.save) onSave();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [chrome.save, onSave]);
  // The undo/redo affordances read the active frame's own stack (per-file); the keyboard peer below
  // re-subscribes only when the enablement flips.
  const { apply } = session;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // Editing-key parity with the toolbar buttons: ⌘/Ctrl+Z undoes, +Shift+Z or Ctrl+Y redoes. A
      // text field keeps its own native undo — a keystroke run is a field concern until it blurs.
      const key = event.key.toLowerCase();
      if (!(event.metaKey || event.ctrlKey) || (key !== "z" && key !== "y")) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      )
        return;
      const wantsRedo = key === "y" || (key === "z" && event.shiftKey);
      if (wantsRedo) {
        if (chrome.redo) {
          event.preventDefault();
          apply({ type: "redo" });
        }
      } else if (chrome.undo) {
        event.preventDefault();
        apply({ type: "undo" });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [chrome.undo, chrome.redo, apply]);

  return (
    <>
      <AppShell
        modeSwitch={
          <ModeSwitch
            mode={session.mode}
            onSwitch={(mode) => {
              doors.switchMode(mode);
            }}
          />
        }
        // The top bar's centre names the file being edited; a file status, when there is one,
        // replaces the name.
        title={
          <FileStatus
            frame={active}
            saveState={session.saveState}
            onReload={() => session.apply({ type: "reload" })}
            fileName={
              openedResult ? (
                inTemplateMode ? (
                  <TemplateFileName template={activeTemplate ?? null} />
                ) : (
                  <WorkflowFileName path={activePath} />
                )
              ) : null
            }
          />
        }
        toolbar={
          session.registry.phase === "ready" ? (
            <EditingToolbar
              chrome={chrome}
              onNew={doors.newDocument}
              onOpen={onOpen}
              onUndo={() => apply({ type: "undo" })}
              onRedo={() => apply({ type: "redo" })}
              onSave={onSave}
              // Save as…: in template mode a copy to a new template; in workflow mode first a
              // choice between a copy to a new workflow file and a new template made from the
              // workflow's body.
              onSaveAs={() => setDialog(saveAsDialog(session.mode))}
              onTakeover={() => activePath && takeover(activePath)}
              onReacquire={() => activePath && reacquire(activePath)}
              onDelete={onDelete}
              onDownload={onDownload}
              onUpload={() => uploadInput.current?.click()}
            />
          ) : undefined
        }
        palette={
          <Palette
            plugins={plugins}
            templateList={templateList}
            arming={arming}
            // In template mode, a double-click opens the template source, discarding the current
            // stack.
            onEditTemplate={doors.openTemplate}
            canEditTemplates={inTemplateMode}
          />
        }
        canvas={
          <RunProjectionProvider view={run.projectionView}>
            <SelectionProvider value={{ selectedId, onSelect: setSelectedId }}>
              <Canvas
                session={session}
                plugins={plugins}
                armed={arming.armed}
                onArm={arming.arm}
                problems={problems}
                onNew={doors.newDocument}
                onOpenExisting={onOpen}
                // Double-click an unset `workflow` block to author its target — the same chooser
                // the pane's "Add a workflow reference" opens, offered only when the parent has a
                // path for a relative ref.
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
              applyEdit={(next, key) => session.apply({ type: "applyEdit", next, key })}
              // The ref-target chooser needs the parent's path to store a relative ref, so offer it
              // only for a file that has one; a from-scratch root falls back to the plain path
              // field.
              onAddRefTarget={refAuthoring.onAuthorRef}
            />
          ) : (
            <div className="pane pane-idle">
              <p className="pane-hint">
                {t("paneIdle", { mode: inTemplateMode ? "template" : "workflow" })}
              </p>
            </div>
          )
        }
        runDock={
          <RunDock
            client={client}
            disabledReason={inTemplateMode ? t("templatesDoNotRun") : undefined}
            plugins={plugins}
            // An unwritten buffer has no file on disk for the server to load, so it cannot launch.
            // A create-new child carries a pre-assigned path, so gate the launch handle on
            // `written`, not on the path: an unwritten child reads as unsaved rather than relying
            // on its always-dirty buffer.
            workflowPath={active?.written ? (activePath ?? null) : null}
            workflowId={openedFile?.id ?? null}
            rootFile={openedFile}
            dirty={dirty}
            warningCount={warningCount}
            watch={run.watch}
          />
        }
      />
      <input
        ref={uploadInput}
        type="file"
        accept=".json"
        hidden
        data-testid="upload-input"
        onChange={(event) => {
          upload.pick(event.target.files?.[0], discoveredMaxFileBytes(discovery));
          // Cleared, so picking the same file again still fires a change.
          event.target.value = "";
        }}
      />
      {upload.picked !== null ? (
        <UploadDialog
          upload={upload.picked}
          discovery={discovery}
          templateList={templateList}
          start={upload.start}
          onDone={upload.finish}
          onCancel={upload.cancel}
        />
      ) : null}
      {upload.copyOf !== null ? (
        <UploadCopyDialog
          upload={upload.copyOf}
          create={upload.copy}
          onDone={upload.finish}
          onCancel={upload.cancel}
        />
      ) : null}
      {/* The first-save dialog rides above the shell, shown only for a from-scratch buffer (no
        path) whose author asked to save. It decides the path; a successful create closes it and the
        frame is saved. */}
      {openDialog.kind === "new-file" && openedFile && !activeTemplate ? (
        <NewFileDialog
          discovery={discovery}
          workflowName={openedFile.name}
          create={(path) => session.saveAs({ kind: "new-file", path })}
          onCreated={closeDialog}
          onCancel={closeDialog}
        />
      ) : null}
      {/* The three doors that save a new template: a new template's first save, a copy of the
        opened template, and a workflow's body as a template. Each picks its name and description. */}
      {templateSave !== null && openedFile ? (
        <SaveTemplateAsDialog
          source={templateSave.kind === "template-copy" ? (activeTemplate ?? null) : null}
          workflowName={templateSave.kind === "workflow-as-template" ? openedFile.name : undefined}
          droppedFields={
            templateSave.kind === "new-template" ? [] : droppedWorkflowFields(openedFile)
          }
          templateList={templateList}
          create={(input) => session.saveAs({ kind: templateSave.kind, ...input })}
          onCreated={closeDialog}
          onCancel={closeDialog}
        />
      ) : null}
      {openDialog.kind === "save-as" &&
      openDialog.dialog.kind === "workflow-choice" &&
      openedFile ? (
        <SaveAsChoiceDialog
          onWorkflow={() => setDialog(openSaveAs({ kind: "workflow-copy" }))}
          onTemplate={() => setDialog(openSaveAs({ kind: "workflow-template" }))}
          onCancel={closeDialog}
        />
      ) : null}
      {openDialog.kind === "save-as" && openDialog.dialog.kind === "workflow-copy" && openedFile ? (
        <NewFileDialog
          discovery={discovery}
          title={t("saveWorkflowAs")}
          workflowName={`${openedFile.name}-copy`}
          initialDirectory={activePath ? dirnameOf(activePath) : undefined}
          pickOrigin
          create={(path) => session.saveAs({ kind: "workflow-copy", path })}
          onCreated={closeDialog}
          onCancel={closeDialog}
        />
      ) : null}
      {/* The open-existing picker: choose a discovered workflow and open it as a fresh root. Shown
        above the shell from either the empty-canvas affordance or the toolbar's Open button. */}
      {openDialog.kind === "open-workflow" ? (
        <OpenWorkflowDialog
          discovery={discovery}
          onOpen={(path) => {
            closeDialog();
            doors.openWorkflow(path);
          }}
          onCopy={async (path) => {
            await doors.copyShipped(path);
            closeDialog();
          }}
          onCancel={closeDialog}
        />
      ) : null}
      {openDialog.kind === "open-template" ? (
        <OpenTemplateDialog
          templateList={templateList}
          onOpen={(template) => {
            closeDialog();
            doors.openTemplate(template);
          }}
          onCancel={closeDialog}
        />
      ) : null}
      {/* The ref-target chooser: reference an existing workflow, or create a new one and descend
        into its fresh, unwritten child buffer. Shown only while an empty `workflow` node awaits a
        target. */}
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
