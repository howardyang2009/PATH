import type { PathApiClient } from "@path/client-core";
import { useCallback, useState } from "react";
import { type DiscoveryLoad, useWorkflowDiscovery } from "./discovery.js";
import type { SaveState } from "./session-reducer.js";
import { type TemplateListLoad, useTemplateList } from "./template-list.js";

/** The authored files the Designer knows: workflow Discovery and the template list. */
export interface AuthoredFiles {
  discovery: DiscoveryLoad;
  templateList: TemplateListLoad;
  /** Re-scan both, after a write that is not a save (a copy, an upload). */
  rescan(): void;
}

/** Scan the authored files once, again when a save lands, and again on each `rescan`. */
export function useAuthoredFiles(
  client: PathApiClient,
  savePhase: SaveState["phase"],
): AuthoredFiles {
  const [rescanKey, setRescanKey] = useState(0);
  const discovery = useWorkflowDiscovery(client, savePhase, rescanKey);
  const templateList = useTemplateList(client, savePhase, rescanKey);
  const rescan = useCallback(() => setRescanKey((key) => key + 1), []);
  return { discovery, templateList, rescan };
}
