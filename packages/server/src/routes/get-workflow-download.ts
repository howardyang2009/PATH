import { strongEtag } from "../etag.js";
import { sendError } from "../http-json.js";
import { bundleWorkflow } from "../workflow-bundle.js";
import type { StreamRequest } from "./route-context.js";
import { sendDownload } from "./send-download.js";

/**
 * `GET /v0/workflows/download?path=<handle>[&origin=shipped]` (server-api-v0.md §7.4): the saved
 * workflow file, or a zip of its `ref` closure when it refs other workflows. An unresolvable `ref`
 * or a file with bad JSON is a `422` listing each one.
 */
export function handleGetWorkflowDownload({ res, ctx, query }: StreamRequest): void {
  const path = query.get("path");
  const origin = query.get("origin");
  if (origin !== null && origin !== "shipped") {
    sendError(res, 400, 'origin must be "shipped" when present');
    return;
  }
  if (path === null || path === "") {
    sendError(res, 404, "not found");
    return;
  }

  const bundle = bundleWorkflow(ctx.layout, path, origin === "shipped");
  if (!bundle.ok) {
    if (bundle.status === 404) sendError(res, 404, "not found");
    else sendError(res, 422, "workflow refs could not be bundled", bundle.failures);
    return;
  }
  const etag = bundle.contentType === "application/json" ? strongEtag(bundle.bytes) : undefined;
  sendDownload(res, { ...bundle, etag });
}
