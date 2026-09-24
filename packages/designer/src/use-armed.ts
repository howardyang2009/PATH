import { useCallback, useRef, useState } from "react";
import type { GetTemplateResponse, PathApiClient, TemplateSummary } from "@path/client-core";
import { instantiateWorkflow, type WorkflowFile, type WorkflowNode } from "@path/schema";

/**
 * What the palette has **armed** — the thing the canvas opens sockets for and places on a socket click.
 * A Build-tab card arms a node kind (#368); a Step-Template card arms that template's body (#578), which
 * the canvas instantiates on place (ADR 0049). The template body rides in the armed value, fetched once
 * on select, so a place is synchronous and every open socket reads the same body.
 */
export type Armed =
  | { kind: "node"; type: string }
  | { kind: "step-template"; id: string; name: string; body: WorkflowNode[] };

export interface ArmedState {
  armed: Armed | null;
  /** Arm a value directly (a Build card) or disarm (`null`). Supersedes an in-flight template read. */
  arm: (armed: Armed | null) => void;
  /**
   * Arm a Step-Template: disarm at once, read its envelope (`GET /v0/templates/:id`), then arm its body.
   * A failed read or a template the server reports invalid arms nothing and sets `templateError` instead.
   */
  armTemplate: (template: TemplateSummary) => void;
  /**
   * Select a Workflow-Template (#579): disarm at once, read its envelope, run Instantiation plus the
   * workflow-level re-mint (`instantiateWorkflow`), and hand the instance to `place`. Nothing is armed —
   * a Workflow-Template has one target, the empty canvas. A failed read, an invalid template, or a
   * `place` that refuses (the canvas is no longer empty) sets `templateError` instead.
   */
  selectWorkflowTemplate: (template: TemplateSummary, place: (file: WorkflowFile) => boolean) => void;
  /** Why the last template select armed or placed nothing, or `null`. Cleared by the next arm. */
  templateError: string | null;
}

export function useArmed(client: PathApiClient): ArmedState {
  const [armed, setArmed] = useState<Armed | null>(null);
  const [templateError, setTemplateError] = useState<string | null>(null);
  // The latest arm request. A template read that resolves after a newer arm (another card, or a
  // disarm) is stale and dropped, so the last click wins.
  const latest = useRef(0);

  const arm = useCallback((next: Armed | null) => {
    latest.current++;
    setTemplateError(null);
    setArmed(next);
  }, []);

  /**
   * The one template-select spine behind both card kinds: disarm at once, read the envelope, drop a stale
   * landing (the last click wins), and report a failed read. `use` acts on a fresh envelope and returns
   * why it did nothing, or `null` when it succeeded.
   */
  const selectTemplate = useCallback(
    (template: TemplateSummary, use: (envelope: GetTemplateResponse) => string | null) => {
      const request = ++latest.current;
      setTemplateError(null);
      // Disarm while the read is in flight: the previous selection must not stay placeable behind a
      // select that may yet fail.
      setArmed(null);
      const id = template.id;
      if (id === null) return; // an id-less row is invalid, and the palette never offers it
      client
        .getTemplate(id)
        .then((envelope) => {
          if (request !== latest.current) return;
          const error = use(envelope);
          if (error !== null) setTemplateError(error);
        })
        .catch((error: unknown) => {
          if (request !== latest.current) return;
          setTemplateError(`Could not read "${template.name}": ${error instanceof Error ? error.message : String(error)}`);
        });
    },
    [client],
  );

  const armTemplate = useCallback(
    (template: TemplateSummary) =>
      selectTemplate(template, (envelope) => {
        // `valid` is the server's registry-relative check, so a valid step-template body is a
        // `WorkflowNode[]`; `kind` guards a file that changed kind between the list and this read.
        if (!envelope.valid || envelope.kind !== "step" || !Array.isArray(envelope.body)) {
          return `Cannot insert "${template.name}": ${envelope.error?.message ?? "invalid template"}`;
        }
        setArmed({ kind: "step-template", id: envelope.id, name: template.name, body: envelope.body as WorkflowNode[] });
        return null;
      }),
    [selectTemplate],
  );

  const selectWorkflowTemplate = useCallback(
    (template: TemplateSummary, place: (file: WorkflowFile) => boolean) =>
      selectTemplate(template, (envelope) => {
        // A valid Workflow-Template's `body` is its whole workflow file (server-api-v0.md §10.2).
        if (!envelope.valid || envelope.kind !== "workflow" || typeof envelope.body !== "object" || envelope.body === null) {
          return `Cannot use "${template.name}": ${envelope.error?.message ?? "invalid template"}`;
        }
        return place(instantiateWorkflow(envelope.body as WorkflowFile))
          ? null
          : `Cannot use "${template.name}": a Workflow-Template goes only into an empty canvas.`;
      }),
    [selectTemplate],
  );

  return { armed, arm, armTemplate, selectWorkflowTemplate, templateError };
}
