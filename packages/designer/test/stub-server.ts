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

export interface DesignerStubOptions {
  /** The registry snapshot for `GET /v0/step-plugins`. Defaults to the built-in `prompt`/`binary` pair. */
  plugins?: WireStepPlugin[];
  /** Status for the registry response, for the failure path. */
  pluginsStatus?: number;
  /** Raw file bodies keyed by relative path, for `GET /v0/workflows/file`. A path the map lacks answers 404. */
  files?: Record<string, string>;
}

export function stubClient(options: DesignerStubOptions = {}): PathApiClient {
  const plugins = options.plugins ?? DEFAULT_PLUGINS;
  const files = options.files ?? {};

  const fetchLike: FetchLike = async (input) => {
    if (input.startsWith("/v0/step-plugins")) {
      return json({ step_plugins: plugins }, options.pluginsStatus ?? 200);
    }
    const match = /^\/v0\/workflows\/file\?path=(.+)$/.exec(input);
    if (match) {
      const path = decodeURIComponent(match[1]!);
      if (!(path in files)) return json({ error: { message: `not found: ${path}` } }, 404);
      return new Response(files[path], { status: 200, headers: { "Content-Type": "application/json", ETag: '"stub"' } });
    }
    return json({ error: { message: `unexpected request: ${input}` } }, 500);
  };

  return new PathApiClient({ baseUrl: "", fetch: fetchLike });
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
