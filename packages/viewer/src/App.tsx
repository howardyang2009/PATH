import { type PathApiClient, type RootRunSummary } from "@path/client-core";
import { useEffect, useState } from "react";

type LoadState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; runs: RootRunSummary[] };

/**
 * The scaffold smoke screen (issue #45): the whole point is to prove the `@path/viewer` →
 * `@path/client-core` → `path-server` seam end-to-end by calling one real endpoint (`GET /v0/runs`)
 * and rendering the result. The four real read surfaces (runs list, run tree, live narrative, I/O
 * panel) graduate as their own tickets under map #40 — this is deliberately not them.
 */
export function App({ client }: { client: PathApiClient }) {
  const [state, setState] = useState<LoadState>({ phase: "loading" });

  useEffect(() => {
    let cancelled = false;
    client
      .listRuns()
      .then((res) => {
        if (!cancelled) setState({ phase: "ready", runs: res.runs });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setState({ phase: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  return (
    <main style={{ padding: "16px", maxWidth: "640px", margin: "0 auto" }}>
      <h1 style={{ fontSize: "var(--fs-lg)", fontWeight: 600 }}>PATH viewer</h1>
      <p style={{ color: "var(--text-muted)", fontSize: "var(--fs-sm)" }}>
        Scaffold smoke screen — lists root runs to prove the core seam. Real surfaces graduate under
        map #40.
      </p>
      {state.phase === "loading" && <p>Loading runs…</p>}
      {state.phase === "error" && (
        <p role="alert" style={{ color: "var(--status-failed-fg)" }}>
          Failed to load runs: {state.message}
        </p>
      )}
      {state.phase === "ready" && <RunList runs={state.runs} />}
    </main>
  );
}

/**
 * Bare list of run id + status — enough to prove the seam, no more. The styled runs-list surface
 * (status color/glyph pills over the pinned `tokens.css` set) graduates as its own ticket under
 * map #40; the scaffold deliberately stops at plain text.
 */
function RunList({ runs }: { runs: RootRunSummary[] }) {
  if (runs.length === 0) return <p style={{ color: "var(--text-muted)" }}>No runs yet.</p>;
  return (
    <ul style={{ listStyle: "none", padding: 0, margin: 0, fontFamily: "var(--font-mono)", fontSize: "var(--fs-sm)" }}>
      {runs.map((run) => (
        <li
          key={run.run_id}
          style={{ display: "flex", gap: "12px", padding: "6px 8px", borderBottom: "1px solid var(--border)" }}
        >
          <span style={{ color: "var(--text-muted)" }}>{run.status}</span>
          <span>{run.run_id}</span>
        </li>
      ))}
    </ul>
  );
}
