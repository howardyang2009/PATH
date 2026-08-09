import { z } from "zod";
import { ConfigObjectSchema } from "./config.js";
import { formatIssues } from "./format-issues.js";
import { IdSchema, NameSchema } from "./ids.js";
import { interpolatedJsonValue } from "./interpolation.js";
import { childBodies, walkNodes } from "./node-walk.js";
import { NodeArraySchema } from "./nodes.js";
import { STEP_ROOTS } from "./roots.js";
import { WorkerSchema } from "./worker.js";
import { FORMAT_VERSION, type WorkflowFile } from "./workflow-file-type.js";
import type { WorkflowNode } from "./node-type.js";

export { FORMAT_VERSION };

const BaseWorkflowFileSchema = z
  .object({
    format: z.literal(FORMAT_VERSION),
    name: NameSchema,
    worker: WorkerSchema,
    config: ConfigObjectSchema.optional(),
    body: NodeArraySchema,
    output: z.record(interpolatedJsonValue(STEP_ROOTS)).optional(),
  })
  .strict();

interface IdOccurrence {
  id: string;
  path: (string | number)[];
}

// Every body node (steps, blocks, checkpoints) and every parallel branch carries a required id,
// unique across the whole file at every nesting level (workflow-format-v0.md §3).
function collectIds(nodes: WorkflowNode[], basePath: (string | number)[]): IdOccurrence[] {
  const found: IdOccurrence[] = [];

  nodes.forEach((node, index) => {
    const nodePath = [...basePath, index];
    found.push({ id: node.id, path: [...nodePath, "id"] });

    for (const child of childBodies(node)) {
      // A parallel branch's own id is not a node's, and is unique on the same terms.
      if (child.branchId !== undefined) {
        found.push({ id: child.branchId, path: [...nodePath, ...child.path.slice(0, -1), "id"] });
      }
      found.push(...collectIds(child.nodes, [...nodePath, ...child.path]));
    }
  });

  return found;
}

// Publish keys are static strings, so a race between sibling parallel branches writing the same
// context key is detectable — and rejected — at load time (workflow-format-v0.md §10). Walks nested
// control blocks but not into a `workflow` step's ref'd file: that file has its own isolated
// context (childBodies does not descend there).
function collectPublishKeys(nodes: WorkflowNode[]): string[] {
  const keys: string[] = [];
  for (const node of walkNodes(nodes)) {
    if ((node.type === "prompt" || node.type === "binary" || node.type === "workflow") && node.publish) {
      keys.push(...Object.keys(node.publish));
    }
  }
  return keys;
}

interface PublishKeyCollision {
  key: string;
  path: (string | number)[];
}

function findDuplicatePublishKeys(nodes: WorkflowNode[], basePath: (string | number)[]): PublishKeyCollision[] {
  const collisions: PublishKeyCollision[] = [];

  nodes.forEach((node, index) => {
    const nodePath = [...basePath, index];

    // A `wait-one` parallel lands only the winner's publishes, so two branches publishing the same
    // key is deterministic — and is the headline race-two-sources pattern (wait-one-join.md §4.1).
    // The same-key ban is correct only for `collect`, where all branches land and two writes to one
    // key would be a last-writer race. Recursion still descends into a wait-one block's branches.
    const collisionsAllowed = node.type === "parallel" && node.join === "wait-one";

    // Only *concurrent* siblings can race. Branch arms are alternatives (one runs) and while-do
    // iterations are sequential, so neither collides with itself — `concurrent` is the rule.
    const firstSeenIn = new Map<string, number>();
    childBodies(node).forEach((child, childIndex) => {
      if (child.concurrent && !collisionsAllowed) {
        for (const key of new Set(collectPublishKeys(child.nodes))) {
          if (firstSeenIn.has(key)) {
            collisions.push({ key, path: [...nodePath, ...child.path.slice(0, -1)] });
          } else {
            firstSeenIn.set(key, childIndex);
          }
        }
      }
      collisions.push(...findDuplicatePublishKeys(child.nodes, [...nodePath, ...child.path]));
    });
  });

  return collisions;
}

export const WorkflowFileSchema: z.ZodType<WorkflowFile> = BaseWorkflowFileSchema.superRefine((file, ctx) => {
  const occurrences = collectIds(file.body, ["body"]);
  const byId = new Map<string, IdOccurrence[]>();
  for (const occurrence of occurrences) {
    const list = byId.get(occurrence.id) ?? [];
    list.push(occurrence);
    byId.set(occurrence.id, list);
  }

  for (const [id, list] of byId) {
    if (list.length <= 1) continue;
    for (const occurrence of list.slice(1)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: occurrence.path,
        message: `duplicate id "${id}": ids must be unique across the whole file`,
      });
    }
  }

  for (const collision of findDuplicatePublishKeys(file.body, ["body"])) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: collision.path,
      message: `duplicate publish key "${collision.key}": sibling parallel branches must not publish the same context key`,
    });
  }
});

export interface WorkflowFileParseSuccess {
  success: true;
  data: WorkflowFile;
}

export interface WorkflowFileParseFailure {
  success: false;
  errors: string[];
}

export function safeParseWorkflowFile(
  json: unknown,
): WorkflowFileParseSuccess | WorkflowFileParseFailure {
  const result = WorkflowFileSchema.safeParse(json);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, errors: formatIssues(result.error) };
}

export function parseWorkflowFile(json: unknown): WorkflowFile {
  const result = safeParseWorkflowFile(json);
  if (!result.success) {
    throw new Error(`invalid workflow file:\n${result.errors.join("\n")}`);
  }
  return result.data;
}
