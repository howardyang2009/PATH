import { useCallback, useRef, useState } from "react";
import type { GetTemplateResponse, PathApiClient, TemplateSummary } from "@path/client-core";
import type { WorkflowNode } from "@path/schema";

/**
 * What the palette has **armed** — the thing the canvas opens sockets for and places on a socket click.
 * A Build-tab card arms a node kind (#368); a Template card arms that template's body (#578), which
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
   * Arm a Template: disarm at once, read its envelope (`GET /v0/templates/:id`), then arm its body.
   * A failed read or a template the server reports invalid arms nothing and sets `templateError` instead.
   */
  armTemplate: (template: TemplateSummary) => void;
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
        // `valid` is the server's registry-relative check, so a valid template body is a
        // `WorkflowNode[]`; `kind` guards a file that changed kind between the list and this read.
        if (!envelope.valid || envelope.kind !== "step" || !Array.isArray(envelope.body)) {
          return `Cannot insert "${template.name}": ${envelope.error?.message ?? "invalid template"}`;
        }
        setArmed({ kind: "step-template", id: envelope.id, name: template.name, body: envelope.body as WorkflowNode[] });
        return null;
      }),
    [selectTemplate],
  );

  return { armed, arm, armTemplate, templateError };
}
