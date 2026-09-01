import type { ServerResponse } from "node:http";
import { toWireStepPlugins, type StepPluginsResponse } from "@path/schema";
import { sendJson } from "../http-json.js";
import type { RunsRouteContext } from "./post-runs.js";

/**
 * `GET /v0/step-plugins` (server-api-v0.md §8): serve the server's step-plugin registry as data, so the
 * browser Designer — which cannot scan `packages/engine/step-plugins/` — reproduces exactly the grammar
 * it may author (designer-spec.md § The v1 authoring palette, ADR 0018). One snake_case entry per
 * registered leaf step type: `prompt` and `binary` (ADR 0021) alongside any plugin type.
 *
 * A read has no side effect, so it is ungated (§2.1) and carries no query params. It serves the
 * snapshot the server froze at start (`ctx.stepPlugins`), never a fresh scan: it is a **bare snapshot
 * with no staleness contract** (ADR 0018 sub-3). Currency is re-checked at *write*, not here — `PUT
 * /v0/workflows` re-validates every save against the live registry — so a stale snapshot surfaces as a
 * rejected write, never a corrupt file. A broken plugin folder already failed the server at start (ADR
 * 0019 sub-16), so for a live server this route is always `200`.
 */
export function handleGetStepPlugins(res: ServerResponse, ctx: RunsRouteContext): void {
  const body: StepPluginsResponse = toWireStepPlugins(ctx.stepPlugins);
  sendJson(res, 200, body);
}
