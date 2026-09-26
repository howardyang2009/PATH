import type { IncomingMessage, ServerResponse } from "node:http";
import { join, relative, resolve } from "node:path";
import { formatIssues, makeStepTemplateSchema, NameSchema, safeParseStepTemplateWith, type WireTemplateWriteResponse } from "@path/schema";
import { z } from "zod";
import { writeArtifact } from "../artifact-file.js";
import { readJsonBody, sendError } from "../http-json.js";
import { kindDirFor, suffixFor, userTemplateRoot } from "../template-store.js";
import type { RunsRouteContext } from "./post-runs.js";

/**
 * The save-as envelope (server-api-v0.md §10.3): `{ kind, name, description, body }`. `kind` is always
 * `"step"` (ADR 0063); `name` is the file stem (`NameSchema`); `body` is the **full template object** —
 * the step-template envelope — carrying the client-minted `id`
 * (ADR 0015). The server writes `body` verbatim; the outer `name`/`kind` are the filename, not the
 * bytes.
 */
const PostTemplateBodySchema = z
  .object({
    kind: z.literal("step"),
    name: NameSchema,
    description: z.string(),
    body: z.record(z.string(), z.unknown()),
  })
  .strict();

/**
 * `POST /v0/templates` (server-api-v0.md §10.3, ADR 0050 decision 6): **create-only** save-as into
 * `.path/template/` alone. Origin-gated centrally (state-changing route, §2.1). The server is
 * identity-agnostic — the client mints the envelope `id` inside `body` and the server writes it
 * verbatim (key order preserved, as §7), never a shipped path. A name that already exists in the
 * `<kind-dir>` is a `409`; content changes go through `PUT` (§10.4).
 */
export async function handlePostTemplates(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RunsRouteContext,
): Promise<void> {
  const raw = await readJsonBody(req);
  if (!raw.ok) {
    sendError(res, 400, "request body must be valid JSON");
    return;
  }

  const parsed = PostTemplateBodySchema.safeParse(raw.value);
  if (!parsed.success) {
    sendError(res, 400, "invalid request body", formatIssues(parsed.error));
    return;
  }
  const { kind, name } = parsed.data;
  // The raw `body` sub-object, not zod's parsed copy: serialize it with the author's key order, as
  // `put-workflow` does. `.strict()` above guaranteed it is an object.
  const rawBody = (raw.value as { body: unknown }).body;

  // Registry-relative body validation of the step-template envelope; it surfaces the client-minted `id`.
  const validation = safeParseStepTemplateWith(makeStepTemplateSchema(ctx.stepPlugins), rawBody);
  if (!validation.success) {
    sendError(res, 400, "template validation failed", validation.errors);
    return;
  }
  const envelopeId = validation.data.id;

  const projectDir = resolve(ctx.project.dir);
  const absPath = join(userTemplateRoot(projectDir), kindDirFor(kind), `${name}${suffixFor(kind)}`);
  // Create-only (`wx`): a name that already exists is never a blind overwrite (ADR 0050 decision 6),
  // and that conflict is this door's `409`.
  const written = writeArtifact(absPath, rawBody, { create: true });
  if (!written.ok) {
    sendError(res, 409, `a ${kind} template named "${name}" already exists`);
    return;
  }
  const { etag } = written;
  const reply: WireTemplateWriteResponse = { id: envelopeId, relative_path: relative(projectDir, absPath), etag };
  res.writeHead(201, { "Content-Type": "application/json", ETag: etag });
  res.end(JSON.stringify(reply));
}
