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
}

/** A fresh empty call recorder — pass one into `stubClient({ calls })` and assert against it. */
export function makeCalls(): StubCalls {
  return { lock: [], heartbeat: [], release: [], put: [] };
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
