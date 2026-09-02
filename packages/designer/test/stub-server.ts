import { PathApiClient, type FetchLike, type WireStepPlugin } from "@path/client-core";

/**
 * A stand-in `path-server` for Designer tests: one injected `fetch` routing the two read endpoints the
 * open route uses — `GET /v0/step-plugins` (the registry) and `GET /v0/workflows/file?path=` (the raw
 * bytes). Nothing is mocked above the transport, so tests exercise the real `@path/client-core` decode
 * and the real open pipeline.
 */

/** The built-in trio the Designer ships editors for — `prompt` and `binary` as registry leaf types. */
export const DEFAULT_PLUGINS: WireStepPlugin[] = [
  {
    name: "binary",
    fields: {
      command: { type: "string", optional: false },
      args: { type: "array", optional: true, element: { type: "string", optional: false } },
      cwd: { type: "string", optional: true },
    },
    workers: ["spawn"],
    default_worker: "spawn",
  },
  { name: "prompt", fields: { prompt: { type: "string", optional: false } }, workers: ["sdk"], default_worker: "sdk" },
];

/** Every write/lock request body the stub saw, for assertions in the edit-lock + save tests (#371). */
export interface StubCalls {
  lock: { workflow_path: string; session_id: string; takeover?: boolean }[];
  heartbeat: { workflow_path: string; session_id: string }[];
  release: { workflow_path: string; session_id: string }[];
  put: { body: { workflow_path: string; workflow: Record<string, unknown> }; ifMatch: string | null }[];
  /** The `GET /v0/runs` query strings the run list sent (`?...`), for the `workflow_id`-scope assertions (#372). */
  listRuns: string[];
  /** Every `POST /v0/runs` launch body, for the save-first launch assertions (#372). */
  startRun: { workflow_path: string; input?: unknown; config?: unknown }[];
  /** Every `POST /v0/runs/:id/cancel` root run id (#372). */
  cancel: string[];
  /** Every `POST /v0/runs/:id/resume` — the id and the optional config-override body (#372). */
  resume: { rootRunId: string; body: unknown }[];
}

/** An SSE body that stays open until aborted, like the real one — a stream that ends early spins the
 * core's reconnect loop. Used by the run-surface tests; a silent stream is the default. */
export class EventStreamStub {
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;

  body(signal: AbortSignal | null | undefined): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
        signal?.addEventListener("abort", () => {
          try {
            controller.close();
          } catch {
            // Already closed by an earlier abort — nothing to tear down.
          }
        });
      },
    });
  }

  push(event: Record<string, unknown>): void {
    this.controller?.enqueue(new TextEncoder().encode(`id: ${String(event["seq"])}\ndata: ${JSON.stringify(event)}\n\n`));
  }
}

export interface DesignerStubOptions {
  /** The registry snapshot for `GET /v0/step-plugins`. Defaults to the built-in `prompt`/`binary` pair. */
  plugins?: WireStepPlugin[];
  /** Status for the registry response, for the failure path. */
  pluginsStatus?: number;
  /** Raw file bodies keyed by relative path, for `GET /v0/workflows/file`. A path the map lacks answers 404. */
  files?: Record<string, string>;
  /** A recorder the caller passes in; the stub pushes every write/lock body into it. */
  calls?: StubCalls;
  /** Override `POST /v0/workflows/lock` per call. Default: grant a fresh lease. */
  onLock?: (body: { workflow_path: string; session_id: string; takeover?: boolean }) => Response;
  /** Override `PUT /v0/workflows` per call. Default: 200 with a fresh ETag. */
  onPut?: (body: { workflow_path: string; workflow: Record<string, unknown> }, ifMatch: string | null) => Response;
  /** Body for `GET /v0/runs` — the run-list window. Defaults to an empty list. */
  runs?: unknown;
  /** Body for `GET /v0/runs/:root_run_id` — the run tree. Defaults to an empty tree. */
  tree?: unknown;
  /** Status for the tree response, for the not-found path. */
  treeStatus?: number;
  /** Supply one to push live events into the open SSE stream; omitted means a silent stream. */
  stream?: EventStreamStub;
  /** Bodies for `GET /v0/runs/:root/blobs/:run/:name`, keyed `"<run_id>/<name>"`. A missing key 404s. */
  blobs?: Record<string, unknown>;
  /** Override `POST /v0/runs` per call (the launch). Default: 202 with a fresh `root_run_id`. */
  onStartRun?: (body: { workflow_path: string; input?: unknown; config?: unknown }) => Response;
  /** Body for `GET /v0/workflows` — discovery, the new-file dialog's directory source (#390). Default: empty. */
  workflows?: unknown;
}

/** A fresh empty call recorder — pass one into `stubClient({ calls })` and assert against it. */
export function makeCalls(): StubCalls {
  return { lock: [], heartbeat: [], release: [], put: [], listRuns: [], startRun: [], cancel: [], resume: [] };
}

/** A granted lease for a session — the default lock response. */
function grantedLease(sessionId: string, expiresInMs = 30_000): Response {
  const now = Date.now();
  return json(
    {
      session_id: sessionId,
      acquired_at: new Date(now).toISOString(),
      heartbeat_at: new Date(now).toISOString(),
      expires_at: new Date(now + expiresInMs).toISOString(),
    },
    200,
  );
}

export function stubClient(options: DesignerStubOptions = {}): PathApiClient {
  const plugins = options.plugins ?? DEFAULT_PLUGINS;
  const files = options.files ?? {};
  const calls = options.calls;

  const fetchLike: FetchLike = async (input, init) => {
    if (input.startsWith("/v0/step-plugins")) {
      return json({ step_plugins: plugins }, options.pluginsStatus ?? 200);
    }

    // ── Run surfaces (#372) ─────────────────────────────────────────────────────────────────────
    if (input.endsWith("/events")) {
      const body = (options.stream ?? new EventStreamStub()).body(init?.signal);
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    const blobKey = blobKeyOf(input);
    if (blobKey !== null) {
      const blobs = options.blobs ?? {};
      if (!(blobKey in blobs)) return json({ error: { message: `no blob "${blobKey}"` } }, 404);
      return json(blobs[blobKey], 200);
    }
    const cancelMatch = /^\/v0\/runs\/([^/]+)\/cancel$/.exec(input);
    if (cancelMatch && init?.method === "POST") {
      calls?.cancel.push(decodeURIComponent(cancelMatch[1]!));
      return json({ root_run_id: decodeURIComponent(cancelMatch[1]!) }, 202);
    }
    const resumeMatch = /^\/v0\/runs\/([^/]+)\/resume$/.exec(input);
    if (resumeMatch && init?.method === "POST") {
      const rootRunId = decodeURIComponent(resumeMatch[1]!);
      calls?.resume.push({ rootRunId, body: init?.body ? JSON.parse(init.body as string) : undefined });
      return json({ run_id: "resumed-root", root_run_id: "resumed-root" }, 202);
    }
    if (input === "/v0/runs" && init?.method === "POST") {
      const b = init?.body ? (JSON.parse(init.body as string) as { workflow_path: string; input?: unknown; config?: unknown }) : { workflow_path: "" };
      calls?.startRun.push(b);
      return options.onStartRun ? options.onStartRun(b) : json({ run_id: "new-root", root_run_id: "new-root" }, 202);
    }
    if (input === "/v0/runs" || input.startsWith("/v0/runs?")) {
      calls?.listRuns.push(input.slice("/v0/runs".length));
      return json(options.runs ?? { runs: [] }, 200);
    }
    const treeMatch = /^\/v0\/runs\/([^/?]+)$/.exec(input);
    if (treeMatch && (init?.method ?? "GET") === "GET") {
      return json(options.tree ?? { root_run_id: decodeURIComponent(treeMatch[1]!), status: "pending", output: null, runs: [] }, options.treeStatus ?? 200);
    }
    const fileMatch = /^\/v0\/workflows\/file\?path=(.+)$/.exec(input);
    if (fileMatch) {
      const path = decodeURIComponent(fileMatch[1]!);
      if (!(path in files)) return json({ error: { message: `not found: ${path}` } }, 404);
      return new Response(files[path], { status: 200, headers: { "Content-Type": "application/json", ETag: '"stub"' } });
    }
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
    if (input === "/v0/workflows/lock") {
      const b = body as { workflow_path: string; session_id: string; takeover?: boolean };
      calls?.lock.push(b);
      return options.onLock ? options.onLock(b) : grantedLease(b.session_id);
    }
    if (input === "/v0/workflows/lock/heartbeat") {
      calls?.heartbeat.push(body as { workflow_path: string; session_id: string });
      return grantedLease((body as { session_id: string }).session_id);
    }
    if (input === "/v0/workflows/lock/release") {
      calls?.release.push(body as { workflow_path: string; session_id: string });
      return json({ released: true }, 200);
    }
    if (input === "/v0/workflows" && (init?.method ?? "GET") === "GET") {
      return json(options.workflows ?? { workflows: [] }, 200);
    }
    if (input === "/v0/workflows" && init?.method === "PUT") {
      const ifMatch = ((init.headers as Record<string, string>) ?? {})["If-Match"] ?? null;
      const b = body as { workflow_path: string; workflow: Record<string, unknown> };
      calls?.put.push({ body: b, ifMatch });
      return options.onPut
        ? options.onPut(b, ifMatch)
        : json({ relative_path: b.workflow_path, id: (b.workflow as { id: string }).id, etag: '"saved"' }, 200);
    }
    return json({ error: { message: `unexpected request: ${input}` } }, 500);
  };

  return new PathApiClient({ baseUrl: "", fetch: fetchLike });
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** `"<run_id>/<name>"` for a blob-route URL, or null for any other path. */
function blobKeyOf(url: string): string | null {
  const match = /^\/v0\/runs\/[^/]+\/blobs\/([^/]+)\/([^/?]+)$/.exec(url);
  return match ? `${decodeURIComponent(match[1]!)}/${decodeURIComponent(match[2]!)}` : null;
}
