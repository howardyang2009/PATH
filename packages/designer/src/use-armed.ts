import type { GetTemplateResponse, PathApiClient, TemplateSummary } from "@path/client-core";
import type { WorkflowNode } from "@path/schema";
import { useCallback, useRef, useState } from "react";

/**
 * What the palette has **armed**: a node kind from a Nodes card, or a template's body (ADR 0049). The
 * body is fetched once on select and rides in the armed value, so a place is synchronous.
 */
export type Armed =
  | { kind: "node"; type: string }
  | { kind: "step-template"; id: string; name: string; body: WorkflowNode[] };

export interface ArmedState {
  armed: Armed | null;
  /** Arm a value directly (a Nodes card) or disarm; supersedes an in-flight template read. */
  arm: (armed: Armed | null) => void;
  /** Arm a Template: disarm, read its envelope, then arm its body; a failed or invalid read arms nothing. */
  armTemplate: (template: TemplateSummary) => void;
  /** Why the last template select armed or placed nothing, or `null`. Cleared by the next arm. */
  templateError: string | null;
}

export function useArmed(client: PathApiClient): ArmedState {
  const [armed, setArmed] = useState<Armed | null>(null);
  const [templateError, setTemplateError] = useState<string | null>(null);
  // The latest arm request; a template read resolving after a newer arm is stale and dropped.
  const latest = useRef(0);

  const arm = useCallback((next: Armed | null) => {
    latest.current++;
    setTemplateError(null);
    setArmed(next);
  }, []);

  /** The one template-select spine behind both card kinds: disarm, read the envelope, drop a stale landing
   * (the last click wins), and report a failed read. `use` returns why it did nothing, or `null` on success. */
  const selectTemplate = useCallback(
    (template: TemplateSummary, use: (envelope: GetTemplateResponse) => string | null) => {
      const request = ++latest.current;
      setTemplateError(null);
      // Disarm while the read is in flight: the previous selection must not stay placeable behind it.
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
          setTemplateError(
            `Could not read "${template.name}": ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    },
    [client],
  );

  const armTemplate = useCallback(
    (template: TemplateSummary) =>
      selectTemplate(template, (envelope) => {
        // `valid` is the server's registry-relative check; `kind` guards a file that changed kind since the list read.
        if (!envelope.valid || envelope.kind !== "step" || !Array.isArray(envelope.body)) {
          return `Cannot insert "${template.name}": ${envelope.error?.message ?? "invalid template"}`;
        }
        setArmed({
          kind: "step-template",
          id: envelope.id,
          name: template.name,
          body: envelope.body as WorkflowNode[],
        });
        return null;
      }),
    [selectTemplate],
  );

  return { armed, arm, armTemplate, templateError };
}
