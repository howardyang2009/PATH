import { z } from "zod";
import { ConfigObjectSchema } from "./config.js";
import { formatIssues } from "./format-issues.js";
import { IdSchema, NameSchema } from "./ids.js";
import { interpolatedJsonValue } from "./interpolation.js";
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

    switch (node.type) {
      case "parallel":
        node.branches.forEach((branch, branchIndex) => {
          const branchPath = [...nodePath, "branches", branchIndex];
          found.push({ id: branch.id, path: [...branchPath, "id"] });
          found.push(...collectIds(branch.body, [...branchPath, "body"]));
        });
        break;
      case "branch":
        node.arms.forEach((arm, armIndex) => {
          found.push(...collectIds(arm.body, [...nodePath, "arms", armIndex, "body"]));
        });
        if (node.else) {
          found.push(...collectIds(node.else, [...nodePath, "else"]));
        }
        break;
      case "while-do":
        found.push(...collectIds(node.body, [...nodePath, "body"]));
        break;
      default:
        break;
    }
  });

  return found;
}

// Publish keys are static strings, so a race between sibling parallel branches writing the same
// context key is detectable — and rejected — at load time (workflow-format-v0.md §10). Recurses
// through nested control blocks (a branch's publish may sit inside a nested while-do/branch/
// parallel) but not into a `workflow` step's ref'd file: that file has its own isolated context.
function collectPublishKeys(nodes: WorkflowNode[]): string[] {
  const keys: string[] = [];

  for (const node of nodes) {
    if ((node.type === "prompt" || node.type === "binary" || node.type === "workflow") && node.publish) {
      keys.push(...Object.keys(node.publish));
    }

    switch (node.type) {
      case "parallel":
        for (const branch of node.branches) {
          keys.push(...collectPublishKeys(branch.body));
        }
        break;
      case "branch":
        for (const arm of node.arms) {
          keys.push(...collectPublishKeys(arm.body));
        }
        if (node.else) {
          keys.push(...collectPublishKeys(node.else));
        }
        break;
      case "while-do":
        keys.push(...collectPublishKeys(node.body));
        break;
      default:
        break;
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

    switch (node.type) {
      case "parallel": {
        const firstSeenInBranch = new Map<string, number>();
        node.branches.forEach((branch, branchIndex) => {
          for (const key of new Set(collectPublishKeys(branch.body))) {
            if (firstSeenInBranch.has(key)) {
              collisions.push({ key, path: [...nodePath, "branches", branchIndex] });
            } else {
              firstSeenInBranch.set(key, branchIndex);
            }
          }
          collisions.push(
            ...findDuplicatePublishKeys(branch.body, [...nodePath, "branches", branchIndex, "body"]),
          );
        });
        break;
      }
      case "branch":
        node.arms.forEach((arm, armIndex) => {
          collisions.push(...findDuplicatePublishKeys(arm.body, [...nodePath, "arms", armIndex, "body"]));
        });
        if (node.else) {
          collisions.push(...findDuplicatePublishKeys(node.else, [...nodePath, "else"]));
        }
        break;
      case "while-do":
        collisions.push(...findDuplicatePublishKeys(node.body, [...nodePath, "body"]));
        break;
      default:
        break;
    }
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
