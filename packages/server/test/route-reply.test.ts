import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { handleGetRunBlob } from "../src/routes/get-run-blob.js";
import { handleListRuns } from "../src/routes/list-runs.js";
import type { RouteContext } from "../src/routes/route-context.js";

/**
 * A `reply` handler's own interface is a decoded request in and a reply out. These drive two routes
 * straight through that interface — no socket, no server, no response object — which is what the
 * reply seam exists to allow.
 */
function request<Params extends string[]>(params: Params, query: Record<string, string> = {}) {
  return {
    req: {} as IncomingMessage,
    ctx: {} as RouteContext,
    params,
    query: new URLSearchParams(query),
  };
}

describe("route handlers cross their own interface", () => {
  it("list-runs refuses an invalid limit before it touches the store", () => {
    expect(handleListRuns(request([], { limit: "0" }))).toMatchObject({
      status: 400,
      body: { error: { message: expect.stringContaining("invalid limit") } },
    });
  });

  it("get-run-blob refuses an unserved blob name before it resolves the tree", () => {
    expect(
      handleGetRunBlob(request<[string, string, string]>(["root", "run", "stderr"])),
    ).toMatchObject({ status: 404 });
  });
});
