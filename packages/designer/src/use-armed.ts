import { useCallback, useRef, useState } from "react";
import type { PathApiClient, TemplateSummary } from "@path/client-core";
import type { WorkflowNode } from "@path/schema";

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
   * Arm a Step-Template: read its envelope (`GET /v0/templates/:id`), then arm its body. A failed read
   * or a template the server reports invalid arms nothing and sets `templateError` instead.
   */
  armTemplate: (template: TemplateSummary) => void;
  /** Why the last template select armed nothing, or `null`. Cleared by the next arm. */
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

  const armTemplate = useCallback(
    (template: TemplateSummary) => {
      const request = ++latest.current;
      setTemplateError(null);
      const id = template.id;
      if (id === null) return; // an id-less row is invalid, and the palette never offers it
      client
        .getTemplate(id)
        .then((envelope) => {
          if (request !== latest.current) return;
          if (!envelope.valid || !Array.isArray(envelope.body)) {
            setTemplateError(`Cannot insert "${template.name}": ${envelope.error?.message ?? "invalid template"}`);
            return;
          }
          setArmed({ kind: "step-template", id, name: template.name, body: envelope.body as WorkflowNode[] });
        })
        .catch((error: unknown) => {
          if (request !== latest.current) return;
          setTemplateError(`Could not read "${template.name}": ${error instanceof Error ? error.message : String(error)}`);
        });
    },
    [client],
  );

  return { armed, arm, armTemplate, templateError };
}
