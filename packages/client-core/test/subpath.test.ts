import { describe, expect, it } from "vitest";

import { PathApiClient, PathApiError } from "@path/client-core/api-client";
import { runBlobSource } from "@path/client-core/blob-source";
import { buildCompleteFields } from "@path/client-core/complete-form";
import { RunViewModel } from "@path/client-core/view-model";
import * as barrel from "../src/index.js";

/**
 * `@path/client-core`'s subpaths are seams a surface can name an owner with — the HTTP client, the
 * run view-model, the Complete form model, a run's blob addressing — instead of the whole barrel. A
 * package `exports` map is not checked by tsc alone, so each subpath is resolved here and compared to
 * the barrel entry it names.
 */

describe("@path/client-core subpaths", () => {
  it("hands out the barrel's own HTTP client", () => {
    expect(PathApiClient).toBe(barrel.PathApiClient);
    expect(PathApiError).toBe(barrel.PathApiError);
  });

  it("hands out the barrel's own view-model", () => {
    expect(RunViewModel).toBe(barrel.RunViewModel);
  });

  it("hands out the barrel's own Complete-form model", () => {
    expect(buildCompleteFields).toBe(barrel.buildCompleteFields);
  });

  it("hands out the barrel's own blob addressing", () => {
    expect(runBlobSource).toBe(barrel.runBlobSource);
  });
});
