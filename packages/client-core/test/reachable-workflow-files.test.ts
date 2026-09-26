import { describe, expect, it } from "vitest";
import { type FetchLike, PathApiClient } from "../src/api-client.js";
import { loadReachableWorkflowFiles } from "../src/reachable-workflow-files.js";

/**
 * A `fetch` stub serving workflow files from a `path → body` table, recording every requested path.
 * A path with no entry 404s — the loader must skip it, not throw. Bodies are raw JSON strings so a
 * deliberately malformed file can be tested too.
 */
function stubClient(files: Record<string, unknown | string>): {
  client: PathApiClient;
  paths: string[];
} {
  const paths: string[] = [];
  const fetch: FetchLike = async (input) => {
    const path = decodeURIComponent(new URL(input).searchParams.get("path") ?? "");
    paths.push(path);
    if (!(path in files))
      return new Response(JSON.stringify({ error: { message: "not found" } }), { status: 404 });
    const entry = files[path];
    const text = typeof entry === "string" ? entry : JSON.stringify(entry);
    return new Response(text, { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return { client: new PathApiClient({ baseUrl: "http://localhost:8080", fetch }), paths };
}

function wf(id: string, body: unknown[]): unknown {
  return { format: "path/workflow@5", id, name: id, body };
}

describe("loadReachableWorkflowFiles", () => {
  it("returns the root file first, then every transitively-ref'd sub-file", async () => {
    const { client } = stubClient({
      "main.workflow.json": wf("root", [
        { id: "a", type: "workflow", name: "a", ref: "sub/one.workflow.json" },
        {
          id: "seq",
          type: "sequence",
          name: "seq",
          body: [{ id: "b", type: "workflow", name: "b", ref: "two.workflow.json" }],
        },
      ]),
      "sub/one.workflow.json": wf("one", [
        { id: "c", type: "workflow", name: "c", ref: "../three.workflow.json" },
      ]),
      "two.workflow.json": wf("two", [{ id: "leaf", type: "person-activity", name: "leaf" }]),
      "three.workflow.json": wf("three", []),
    });

    const files = await loadReachableWorkflowFiles(client, "main.workflow.json");

    expect(files.map((f) => f.id)).toEqual(["root", "one", "two", "three"]);
  });

  it("resolves a ref relative to the referencing file's own directory", async () => {
    // `one` sits in `sub/`, so its `../three` ref resolves to the store root, not to `sub/`.
    const { client, paths } = stubClient({
      "sub/one.workflow.json": wf("one", [
        { id: "c", type: "workflow", name: "c", ref: "../three.workflow.json" },
      ]),
      "three.workflow.json": wf("three", []),
    });

    await loadReachableWorkflowFiles(client, "sub/one.workflow.json");

    expect(paths).toContain("three.workflow.json");
  });

  it("skips a missing sub-file rather than failing the whole set", async () => {
    const { client } = stubClient({
      "main.workflow.json": wf("root", [
        { id: "a", type: "workflow", name: "a", ref: "gone.workflow.json" },
      ]),
    });

    const files = await loadReachableWorkflowFiles(client, "main.workflow.json");

    expect(files.map((f) => f.id)).toEqual(["root"]);
  });

  it("yields an empty set when the root file itself cannot be read", async () => {
    const { client } = stubClient({});
    expect(await loadReachableWorkflowFiles(client, "main.workflow.json")).toEqual([]);
  });

  it("fetches each path once, so a ref cycle terminates", async () => {
    const { client, paths } = stubClient({
      "a.workflow.json": wf("a", [
        { id: "toB", type: "workflow", name: "toB", ref: "b.workflow.json" },
      ]),
      "b.workflow.json": wf("b", [
        { id: "toA", type: "workflow", name: "toA", ref: "a.workflow.json" },
      ]),
    });

    const files = await loadReachableWorkflowFiles(client, "a.workflow.json");

    expect(files.map((f) => f.id)).toEqual(["a", "b"]);
    expect(paths.filter((p) => p === "a.workflow.json")).toHaveLength(1);
  });
});
