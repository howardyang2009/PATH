import { z } from "zod";
import { ConfigObjectSchema } from "./config.js";
import { IdSchema, NameSchema } from "./ids.js";
import { interpolatedJsonValue } from "./interpolation.js";
import { NodeArraySchema } from "./nodes.js";
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
    output: z.record(interpolatedJsonValue(["config", "context"])).optional(),
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
});

export interface WorkflowFileParseSuccess {
  success: true;
  data: WorkflowFile;
}

export interface WorkflowFileParseFailure {
  success: false;
  errors: string[];
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
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
