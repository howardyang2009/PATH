import { useEffect, useMemo, useRef, useState } from "react";
import type { PathApiClient } from "@path/client-core";
import { LeaseController, type LeaseMap } from "./lease-client.js";

/**
 * The React binding over `LeaseController` (#371): it mints one `session_id` for the whole Designer
 * session, reconciles the held leases against the open file paths, and wires the two things a browser
 * needs a DOM for — the `beforeunload` release beacon and React state. The pure controller carries the
 * acquire/heartbeat/takeover/lost logic (see `lease-client.ts`); this hook keeps it thin.
 */
export interface EditLeases {
  /** The per-path lease state, for the toolbar/banners to read the active file's lease. */
  leases: LeaseMap;
  /** Take over a lease held by another session (confirmation-gated in the UI). */
  takeover: (path: string) => void;
  /** Re-acquire after the lease was lost (a heartbeat `409`). */
  reacquire: (path: string) => void;
}

export function useEditLeases(client: PathApiClient, paths: readonly string[]): EditLeases {
  // One client-minted UUIDv4 per Designer session (ADR 0015 / ADR 0017), stable across re-renders.
  const sessionId = useRef<string>("");
  if (sessionId.current === "") sessionId.current = crypto.randomUUID();

  const controller = useMemo(() => new LeaseController(client, sessionId.current), [client]);
  const [leases, setLeases] = useState<LeaseMap>(() => controller.snapshot());

  useEffect(() => {
    const unsubscribe = controller.subscribe(setLeases);
    return () => {
      unsubscribe();
      controller.dispose();
    };
  }, [controller]);

  // Reconcile whenever the *set* of open paths changes. Keyed on the joined paths so an unchanged set
  // (a re-render that only reordered React state) does not re-run acquire/release.
  const pathsKey = paths.join("\n");
  useEffect(() => {
    controller.reconcile(pathsKey === "" ? [] : pathsKey.split("\n"));
  }, [controller, pathsKey]);

  // Release-on-close via `navigator.sendBeacon` from `beforeunload` (ADR 0017): POST-only, best-effort.
  // If the beacon never lands (kill, crash), the server's TTL reaps the lease in ≤30s.
  useEffect(() => {
    const releaseUrl = client.url("/v0/workflows/lock/release");
    const onUnload = (): void => {
      for (const path of controller.heldPaths()) {
        const body = JSON.stringify({ workflow_path: path, session_id: sessionId.current });
        navigator.sendBeacon(releaseUrl, new Blob([body], { type: "application/json" }));
      }
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [controller, client]);

  return {
    leases,
    takeover: (path) => controller.takeover(path),
    reacquire: (path) => controller.reacquire(path),
  };
}
