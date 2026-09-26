import type { LoadedStepPluginRegistry, Project } from "@path/engine";
import type { LiveRuns } from "../live-runs.js";

/** What every route handler is handed: the one project this server serves, and what it holds for it. */
export interface RouteContext {
  /**
   * The opened project (#64): its `.path/`, its engine settings, what its runs left behind
   * (`project.archive`), and the one way to run a workflow against it.
   */
  project: Project;
  /** The runs this process is executing: starting, cancelling, and watching them. */
  live: LiveRuns;
  /**
   * The step-plugin registry frozen at server start, served by `GET /v0/step-plugins` as the Designer's
   * authoring palette (server-api-v0.md §8, ADR 0018). A bare snapshot with no staleness contract:
   * scanned once, never per request, so the palette is fixed for the server's life.
   */
  stepPlugins: LoadedStepPluginRegistry;
  /**
   * The shipped (read-only) template root the `/v0/templates` union scans (server-api-v0.md §10, ADR
   * 0050). Defaults to `packages/server/template` when absent; a test injects a fixture root here.
   */
  shippedTemplateDir?: string;
}
