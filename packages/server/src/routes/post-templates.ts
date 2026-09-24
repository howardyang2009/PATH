import { mkdirSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join, relative, resolve } from "node:path";
import {
  formatIssues,
  makeStepTemplateSchema,
  makeWorkflowFileSchema,
  NameSchema,
  safeParseStepTemplateWith,
  safeParseWorkflowFileWith,
} from "@path/schema";
import { z } from "zod";
import { strongEtag } from "../etag.js";
import { readJsonBody, sendError } from "../http-json.js";
import { kindDirFor, suffixFor, userTemplateRoot } from "../template-store.js";
import type { RunsRouteContext } from "./post-runs.js";

/**
 * The save-as envelope (server-api-v0.md §10.3): `{ kind, name, description, body }`. `kind` selects
 * the `<kind-dir>` and suffix; `name` is the file stem (`NameSchema`); `body` is the **full template
 * object** — a step-template envelope or a whole workflow file — carrying the client-minted `id`
 * (ADR 0015). The server writes `body` verbatim; the outer `name`/`kind` are the filename, not the
 * bytes.
 */
const PostTemplateBodySchema = z
  .object({
    kind: z.enum(["step", "workflow"]),
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

  // Registry-relative body validation: a step-template envelope against `makeStepTemplateSchema`, a
  // whole workflow file against the workflow-file schema. Both surface the client-minted `id`.
  const validation =
    kind === "step"
      ? safeParseStepTemplateWith(makeStepTemplateSchema(ctx.stepPlugins), rawBody)
      : safeParseWorkflowFileWith(makeWorkflowFileSchema(ctx.stepPlugins), rawBody);
  if (!validation.success) {
    sendError(res, 400, "template validation failed", validation.errors);
    return;
  }
  const envelopeId = validation.data.id;

  const projectDir = resolve(ctx.project.dir);
  const absPath = join(userTemplateRoot(projectDir), kindDirFor(kind), `${name}${suffixFor(kind)}`);
  const serialized = `${JSON.stringify(rawBody, null, 2)}\n`;
  try {
    mkdirSync(dirname(absPath), { recursive: true });
    // `wx` is the create-only guard: a name that already exists fails `EEXIST`, never a blind
    // overwrite (ADR 0050 decision 6) — that is the `409` below.
    writeFileSync(absPath, serialized, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      sendError(res, 409, `a ${kind} template named "${name}" already exists`);
      return;
    }
    throw err;
  }

  const etag = strongEtag(Buffer.from(serialized, "utf8"));
  const reply = { id: envelopeId, relative_path: relative(projectDir, absPath), etag };
  res.writeHead(201, { "Content-Type": "application/json", ETag: etag });
  res.end(JSON.stringify(reply));
}
