import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, relative, resolve } from "node:path";
import { validateWorkflowFile } from "@path/engine";
import { childBodies, formatIssues, type WorkflowFile, type WorkflowNode } from "@path/schema";
import { z } from "zod";
import { confineToProjectRoot } from "../confine.js";
import { strongEtag } from "../etag.js";
import { readJsonBody, sendError } from "../http-json.js";
import { firstHeader } from "../origin-gate.js";
import type { RunsRouteContext } from "./post-runs.js";

/**
 * The write envelope (server-api-v0.md §7): the resource path travels in the body, not the URL, so a
 * `/`-bearing `workflow_path` needs no `%2F` encoding and resolves exactly as `POST /v0/runs`
 * resolves its own `workflow_path`. `workflow` is the workflow object (snake_case wire, §1) — required
 * and must be an object; its shape is validated separately against `@path/schema` further down.
 */
const PutWorkflowBodySchema = z
  .object({
    workflow_path: z.string().min(1),
    workflow: z.record(z.unknown()),
  })
  .strict();

interface IdOccurrence {
  id: string;
  path: (string | number)[];
}

/**
 * Every node's `id` and where it sits, mirroring `@path/schema`'s `collectNames` walk (one flat
 * namespace at every nesting level — a `parallel` branch, a branch arm, the `else`, a `while-do` body
 * are all ordinary nodes reached through `childBodies`).
 */
function collectIds(nodes: WorkflowNode[], basePath: (string | number)[]): IdOccurrence[] {
  const found: IdOccurrence[] = [];
  nodes.forEach((node, index) => {
    const nodePath = [...basePath, index];
    found.push({ id: node.id, path: [...nodePath, "id"] });
    for (const child of childBodies(node)) {
      found.push(...collectIds(child.nodes, [...nodePath, ...child.path]));
    }
  });
  return found;
}

/**
 * The internally-duplicate-`id` check the write door owns (ADR 0015, ADR 0016): the copy-paste
 * collision the Designer makes reachable. Node `id` uniqueness is *asserted* by `@path/schema`'s name
 * walk ("unique by construction") but not *checked* there, so the write validates it here — over the
 * same flat namespace as `name`, plus the workflow's own `id`. Each duplicate names **both** offending
 * paths, so a Designer can mark the canvas and a hand-rolled client can find the line — never a bare
 * "duplicate id".
 */
function duplicateIdErrors(file: WorkflowFile): string[] {
  const occurrences: IdOccurrence[] = [{ id: file.id, path: ["id"] }, ...collectIds(file.body, ["body"])];
  const byId = new Map<string, (string | number)[][]>();
  for (const { id, path } of occurrences) {
    const list = byId.get(id) ?? [];
    list.push(path);
    byId.set(id, list);
  }

  const errors: string[] = [];
  for (const [id, paths] of byId) {
    if (paths.length <= 1) continue;
    const first = paths[0]!.join(".");
    for (const path of paths.slice(1)) {
      errors.push(`${path.join(".")}: duplicate id "${id}": id already used at ${first}`);
    }
  }
  return errors;
}

/**
 * `PUT /v0/workflows` (server-api-v0.md §7, ADR 0016): the write door. One verb for both create and
 * overwrite, the resource path in the body, concurrency via an `If-Match` precondition. It is
 * `@path/server`'s first write path for files.
 *
 * Checks run cheapest- and security-first, before the disk is touched (§7): the origin gate already
 * ran centrally (state-changing route, §2.1); here — body is valid JSON, envelope schema, path
 * confine/symlink, workflow schema + duplicate-id, precondition, then the write.
 *
 * The server is **identity-agnostic** (ADR 0015): it validates the incoming `id` *shape* but never
 * stamps a missing `id`, never re-mints, and never diffs against the file on disk. It serializes the
 * client's workflow object deterministically (`JSON.stringify(wf, null, 2)` + a trailing newline,
 * author key order preserved) and owns the on-disk bytes.
 */
export async function handlePutWorkflow(req: IncomingMessage, res: ServerResponse, ctx: RunsRouteContext): Promise<void> {
  const body = await readJsonBody(req);
  if (!body.ok) {
    sendError(res, 400, "request body must be valid JSON");
    return;
  }

  const parsed = PutWorkflowBodySchema.safeParse(body.value);
  if (!parsed.success) {
    sendError(res, 400, "invalid request body", formatIssues(parsed.error));
    return;
  }
  const { workflow_path: workflowPath } = parsed.data;
  // Serialize the *raw* object from the request, not zod's parsed copy: `WorkflowFileSchema` may emit
  // keys in schema order, which would silently reorder the author's file. The raw object preserves the
  // key order the client sent (ADR 0016). Envelope `.strict()` already guaranteed it is an object.
  const rawWorkflow = (body.value as { workflow: unknown }).workflow;

  // Path confinement (404) before schema (400): a path that escapes the root or traverses a symlink is
  // refused regardless of what the body says. The two 404 causes fold into one response, as the read
  // door does.
  const absPath = confineToProjectRoot(resolve(ctx.project.dir), workflowPath, { allowMissingTail: true });
  if (absPath === undefined) {
    sendError(res, 404, "not found");
    return;
  }

  const validation = await validateWorkflowFile(rawWorkflow);
  if (!validation.success) {
    sendError(res, 400, "workflow validation failed", validation.errors);
    return;
  }
  const duplicates = duplicateIdErrors(validation.file);
  if (duplicates.length > 0) {
    sendError(res, 400, "workflow validation failed", duplicates);
    return;
  }

  // Read the current bytes once. The precondition and the write are a single synchronous block below —
  // no `await` between them — so no other request of this process can interleave; the only concurrency
  // the precondition guards is an *external* writer (an editor, `git`, the CLI, a second tab), and
  // that is exactly what the ETag detects (ADR 0016; #258's lease is separate politeness).
  let currentBytes: Buffer | undefined;
  try {
    currentBytes = readFileSync(absPath);
  } catch {
    currentBytes = undefined;
  }
  const existed = currentBytes !== undefined;

  const ifMatch = firstHeader(req.headers["if-match"]);
  if (ifMatch !== undefined) {
    // `If-Match: <etag>` present → overwrite-only. `412` if the file is gone or its bytes changed since
    // read. Only a matching ETag overwrites: there is no `If-Match: *` wildcard here — the docs are
    // explicit that no header spells a blind last-writer-wins overwrite (ADR 0016), so `*` fails the
    // exact-match like any other stale value.
    if (!existed) {
      sendError(res, 412, "precondition failed: the file no longer exists");
      return;
    }
    if (ifMatch !== strongEtag(currentBytes!)) {
      sendError(res, 412, "precondition failed: the file changed since it was read");
      return;
    }
  } else if (existed) {
    // No `If-Match` → create-only. There is no header spelling for a blind last-writer-wins overwrite:
    // every overwrite must present a matching ETag (ADR 0016).
    sendError(res, 412, "precondition failed: the file already exists (send If-Match to overwrite)");
    return;
  }

  const serialized = `${JSON.stringify(rawWorkflow, null, 2)}\n`;
  try {
    // Intermediate dirs of a client-named nested path are created inside the confined, symlink-free
    // chain `confineForWrite` walked. A create uses `wx` so a file that raced into existence between
    // the read above and here fails `EEXIST` rather than clobbering it — folded into the create-only
    // `412`.
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, serialized, existed ? undefined : { flag: "wx" });
  } catch (err) {
    if (!existed && (err as NodeJS.ErrnoException).code === "EEXIST") {
      sendError(res, 412, "precondition failed: the file already exists (send If-Match to overwrite)");
      return;
    }
    throw err;
  }

  const etag = strongEtag(Buffer.from(serialized, "utf8"));
  const relativePath = relative(resolve(ctx.project.dir), absPath);
  res.writeHead(existed ? 200 : 201, { "Content-Type": "application/json", ETag: etag });
  res.end(JSON.stringify({ relative_path: relativePath, id: validation.file.id, etag }));
}
