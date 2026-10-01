import { NameSchema, type WireTemplateWriteResponse } from "@path/schema";
import { z } from "zod";
import { readRequestBody, sendError } from "../http-json.js";
import { templatesOf } from "../template-store.js";
import type { ApiRequest } from "./route-context.js";

/** A `/`-separated subfolder path: no empty, dot-leading, or backslash segments, so it cannot leave
 * the user's template folder. */
const FolderSchema = z
  .string()
  .regex(
    /^[^\\./\0][^\\/\0]*(\/[^\\./\0][^\\/\0]*)*$/,
    "folder must be a relative path of plain names",
  );

/**
 * The save-as envelope (§10.3): `kind` is always `"step"`, `name` is the file stem, and `body` is
 * the full template object carrying the client-minted `id` (ADR 0015).
 */
const PostTemplateBodySchema = z
  .object({
    kind: z.literal("step"),
    name: NameSchema,
    folder: FolderSchema.optional(),
    description: z.string(),
    body: z.record(z.string(), z.unknown()),
  })
  .strict();

/**
 * `POST /v0/templates` (server-api-v0.md §10.3): **create-only** save-as into
 * `users/<user-id>/template/` alone. The client mints the envelope `id` and the server writes it
 * verbatim, never to a shipped path. A name that already exists is a `409`; content changes go through `PUT` (§10.4).
 */
export async function handlePostTemplates({ req, res, ctx }: ApiRequest): Promise<void> {
  const body = await readRequestBody(req, res, PostTemplateBodySchema);
  if (!body) return;
  const { kind, name, folder } = body.data;
  // The raw `body` sub-object, not zod's parsed copy, so the author's key order is preserved.
  const rawBody = (body.raw as { body: unknown }).body;

  // The store validates the envelope, refuses a taken name or id, and writes.
  const written = templatesOf(ctx).create(kind, name, rawBody, folder);
  if (!written.ok) {
    sendError(
      res,
      written.status,
      written.message,
      "details" in written ? written.details : undefined,
    );
    return;
  }
  const reply: WireTemplateWriteResponse = {
    id: written.id,
    relative_path: written.relativePath,
    etag: written.etag,
  };
  res.writeHead(201, { "Content-Type": "application/json", ETag: written.etag });
  res.end(JSON.stringify(reply));
}
