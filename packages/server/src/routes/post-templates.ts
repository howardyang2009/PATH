import { join, relative, resolve } from "node:path";
import {
  makeStepTemplateSchema,
  NameSchema,
  safeParseStepTemplateWith,
  type WireTemplateWriteResponse,
} from "@path/schema";
import { z } from "zod";
import { writeArtifact } from "../artifact-file.js";
import { readRequestBody, sendError } from "../http-json.js";
import { kindDirFor, suffixFor, userTemplateRoot } from "../template-store.js";
import type { ApiRequest } from "./route-context.js";

/**
 * The save-as envelope (§10.3): `kind` is always `"step"`, `name` is the file stem, and `body` is the full template
 * object carrying the client-minted `id` (ADR 0015).
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
 * `POST /v0/templates` (server-api-v0.md §10.3): **create-only** save-as into `.path/template/` alone.
 * The client mints the envelope `id` and the server writes it verbatim, never to a shipped path. A name
 * that already exists is a `409`; content changes go through `PUT` (§10.4).
 */
export async function handlePostTemplates({ req, res, ctx }: ApiRequest): Promise<void> {
  const body = await readRequestBody(req, res, PostTemplateBodySchema);
  if (!body) return;
  const { kind, name } = body.data;
  // The raw `body` sub-object, not zod's parsed copy, so the author's key order is preserved.
  const rawBody = (body.raw as { body: unknown }).body;

  // Registry-relative validation of the step-template envelope; it surfaces the client-minted `id`.
  const validation = safeParseStepTemplateWith(makeStepTemplateSchema(ctx.stepPlugins), rawBody);
  if (!validation.success) {
    sendError(res, 400, "template validation failed", validation.errors);
    return;
  }
  const envelopeId = validation.data.id;

  const projectDir = resolve(ctx.project.dir);
  const absPath = join(userTemplateRoot(projectDir), kindDirFor(kind), `${name}${suffixFor(kind)}`);
  // Create-only (`wx`): an existing name is never a blind overwrite (ADR 0050), and is this door's `409`.
  const written = writeArtifact(absPath, rawBody, { create: true });
  if (!written.ok) {
    sendError(res, 409, `a ${kind} template named "${name}" already exists`);
    return;
  }
  const { etag } = written;
  const reply: WireTemplateWriteResponse = {
    id: envelopeId,
    relative_path: relative(projectDir, absPath),
    etag,
  };
  res.writeHead(201, { "Content-Type": "application/json", ETag: etag });
  res.end(JSON.stringify(reply));
}
