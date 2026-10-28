import type { PathApiClient, TemplateSummary } from "@path/client-core";
import type { Message } from "@path/i18n";
import { useState } from "react";
import {
  type EditMode,
  type Frame,
  frameHasUnsavedWork,
  type SessionAction,
  type TemplateSource,
} from "./session-reducer.js";
import type { Upload } from "./upload.js";
import {
  readPickedFile,
  startUpload,
  type UploadLease,
  type UploadOutcome,
  uploadCopy,
} from "./upload-file.js";

/** What the doors ask the author: whether to drop unsaved work, whether an upload may replace the
 * author's own file, and what to show when an upload is refused. */
export interface DoorPrompts {
  discardUnsaved: () => boolean;
  replaceUpload: (fileName: string) => boolean;
  uploadRefused: (message: Message) => void;
}

/** What the doors act on: the session they replace, the palette they disarm, and the authored-file
 * scans they refresh after a write that is not a save. */
export interface DoorContext {
  client: PathApiClient;
  session: { frames: readonly Frame[]; mode: EditMode; apply: (action: SessionAction) => void };
  disarm: () => void;
  rescan: () => void;
  prompts: DoorPrompts;
}

/** The doors that replace the open stack with another document. */
export interface DocumentDoors {
  /** A new workflow or a new template, by mode. */
  newDocument(): void;
  switchMode(mode: EditMode): void;
  openWorkflow(path: string): void;
  /** Open a template's own source in template mode; an id-less (malformed) template stays shut. */
  openTemplate(template: TemplateSummary): void;
  /** Copy a shipped workflow into the user's folder (ADR 0086) and open the copy. A copy refusal
   * rejects, for the picker to show. */
  copyShipped(shippedPath: string): Promise<void>;
  /** Open what an upload wrote: the author already agreed to drop unsaved work when picking it. */
  openUploaded(outcome: UploadOutcome): void;
}

/** Whether the stack may be replaced: no frame has unsaved work, or the author agrees to drop it. */
function mayDiscard({ session, prompts }: DoorContext): boolean {
  return !session.frames.some((frame) => frameHasUnsavedWork(frame)) || prompts.discardUnsaved();
}

/**
 * Every door that replaces the stack runs the same steps, in this order: ask before dropping unsaved
 * work (an untouched New buffer has none, so it goes quietly), then write if the door writes, then
 * disarm the palette so an in-flight template read cannot land after the open, then open.
 */
export function documentDoors(context: DoorContext): DocumentDoors {
  const { client, session, disarm, rescan, prompts } = context;
  const replace = (action: SessionAction): void => {
    disarm();
    session.apply(action);
  };
  const openTemplateSource = (template: TemplateSource): void =>
    replace({ type: "openTemplateLoading", template });

  return {
    newDocument() {
      if (!mayDiscard(context)) return;
      replace({ type: session.mode === "template" ? "newTemplate" : "newFile" });
    },
    switchMode(mode) {
      if (mayDiscard(context)) replace({ type: "switchMode", mode });
    },
    openWorkflow(path) {
      if (mayDiscard(context)) replace({ type: "openLoading", path });
    },
    openTemplate(template) {
      if (template.id === null || !mayDiscard(context)) return;
      openTemplateSource({
        id: template.id,
        kind: template.kind,
        name: template.name,
        description: template.description,
        readOnly: template.read_only && (template.origin === "shipped" ? "shipped" : "shared"),
      });
    },
    async copyShipped(shippedPath) {
      if (!mayDiscard(context)) return;
      const { relativePath } = await client.copyShippedWorkflow(shippedPath);
      rescan();
      replace({ type: "openLoading", path: relativePath });
    },
    openUploaded(outcome) {
      if (outcome.status === "refused") prompts.uploadRefused(outcome.message);
      if (outcome.status !== "done") return;
      rescan();
      if (outcome.target.kind === "workflow") {
        replace({ type: "openLoading", path: outcome.target.path });
      } else {
        openTemplateSource(outcome.target.template);
      }
    },
  };
}

/** Upload's two dialogs: the folder picker for a read file, and the new-name prompt for a copy. */
export interface UploadFlow {
  /** The read file waiting for its folder, or `null`. */
  picked: Upload | null;
  /** The file that must go in as a copy, waiting for its new name, or `null`. */
  copyOf: Upload | null;
  /** Read one picked file, once the author agreed to drop unsaved work. */
  pick(file: File | undefined, maxBytes: number | null): void;
  /** Write the picked file into `folder`. */
  start(folder: string): Promise<UploadOutcome>;
  /** Write the copy under `name`. */
  copy(name: string): Promise<UploadOutcome>;
  /** Close the dialogs and open what was written. */
  finish(outcome: UploadOutcome): void;
  cancel(): void;
}

/** The document doors, plus the Upload flow that ends in one of them. `lease` is this Designer's
 * edit-lease session, so an upload never releases a lease the Designer holds. */
export function useDocumentDoors(
  context: DoorContext,
  lease: UploadLease,
): DocumentDoors & { upload: UploadFlow } {
  const doors = documentDoors(context);
  const [picked, setPicked] = useState<Upload | null>(null);
  const [copyOf, setCopyOf] = useState<Upload | null>(null);
  const finish = (outcome: UploadOutcome): void => {
    setPicked(null);
    setCopyOf(outcome.status === "copy" ? outcome.upload : null);
    doors.openUploaded(outcome);
  };
  const upload: UploadFlow = {
    picked,
    copyOf,
    pick(file, maxBytes) {
      if (file === undefined || !mayDiscard(context)) return;
      void readPickedFile(file, maxBytes).then((read) => {
        if (read.status === "read") setPicked(read.upload);
        else finish(read);
      });
    },
    start(folder) {
      if (picked === null) return Promise.resolve({ status: "cancelled" });
      const confirmReplace = context.prompts.replaceUpload;
      return startUpload(context.client, { ...picked, folder }, { confirmReplace, lease });
    },
    copy(name) {
      if (copyOf === null) return Promise.resolve({ status: "cancelled" });
      return uploadCopy(context.client, copyOf, name);
    },
    finish,
    cancel() {
      setPicked(null);
      setCopyOf(null);
    },
  };
  return { ...doors, upload };
}
