import {
  type ControlBlockKind,
  classifyLevelK,
  type LegalKLevelReason,
  type RunRecord,
  selectBoundary,
  type WorkflowFile,
} from "@path/schema";
import { descendNodePath } from "./descend-node-path.js";

/**
 * The legal-K authority for Resume-from-chosen-K (spec §5, ADR 0032/0036): resolves the source run id
 * to the rerun-boundary (K) node-id descent path and validates it against the current file, so
 * `--from` and `--list-eligible` can never disagree. K is either a node in the root file's serial order
 * (first level or inside sequences, a length-1 path) or a nested node reached by a root→…→K descent;
 * the path comes from walking the run's `parentRunId` chain, and each on-path level is validated
 * against its own file. Refusals, first failure wins: run in no run of the tree (400), deleted node or
 * unsucceeded K/prefix (409), illegal locus in a loop/parallel/branch body (400). The message is the
 * one wording authority a surface prints verbatim.
 */
/**
 * The §5 taxonomy classification of a refusal, exposed so a surface can render a short reason without re-deriving it
 * from the `message` text — the `--list-eligible` column (spec §6).
 */
export type LegalKReasonCode =
  | "not-in-tree" // the run id names no run of the source tree
  | "root-run"
  | "pass-run" // a goto pass container (ADR 0054); K is a node inside it, never the pass itself
  | LegalKLevelReason; // the per-level taxonomy shared with the client's eager mirror (`classifyLevelK`)

/**
 * The innermost enclosing controller named in an `in-body` refusal (spec §6); an alias for `@path/schema`'s
 * `ControlBlockKind`, shared with the client's mirror.
 */
export type LegalKContainer = ControlBlockKind;

/** A legal-K refusal: the HTTP status, the verbatim message and the §5 taxonomy reason code. */
export interface LegalKRefusal {
  status: number;
  message: string;
  reason: LegalKReasonCode;
  /** Only on `reason: "in-body"`: the innermost enclosing controller, so the listing can name it. */
  container?: LegalKContainer;
}

/**
 * A legal K: the node-id descent path root→…→K, and level for level the goto pass each path-node sits in (ADR 0054
 * §6), `null` where the file holds no goto.
 */
export type LegalKResult =
  | { ok: true; nodePath: string[]; passes: (number | null)[] }
  | { ok: false; refusal: LegalKRefusal };

function refuse(
  status: number,
  message: string,
  reason: LegalKReasonCode,
  container?: LegalKContainer,
): LegalKResult {
  return {
    ok: false,
    refusal: container ? { status, message, reason, container } : { status, message, reason },
  };
}

/**
 * Resolve `runId` against the raw source tree `sourceRows` — the predecessor's own rows, not the
 * reuse-swapped plan input, since reasons 4 and 5 read its recorded statuses — and the current
 * `rootFile`/`rootDir` (with `files` for a nested K), returning the boundary node-id path or a refusal.
 */
export function resolveLegalK(
  rootFile: WorkflowFile,
  sourceRows: RunRecord[],
  runId: string,
  files: Map<string, WorkflowFile>,
  rootDir: string,
): LegalKResult {
  // The run id must name a node's run of the source tree: a goto pass is a container (ADR 0054 §3)
  // and the root run owns no node (invariant 2). The rule is shared with the client's mirror.
  const selection = selectBoundary(sourceRows, runId);
  switch (selection.kind) {
    case "not-in-tree":
      return refuse(400, `run id "${runId}" is not in the run tree being resumed`, "not-in-tree");
    case "pass-run":
      return refuse(
        400,
        `run "${runId}" is pass ${selection.pass}, a goto pass container, which is never a rerun boundary; choose a node inside it`,
        "pass-run",
      );
    case "root-run":
      return refuse(
        400,
        `run "${runId}" is the root run, which is never a rerun boundary`,
        "root-run",
      );
  }
  const { levels } = selection;
  const nodePath = levels.map((level) => level.run.nodeId!); // non-null: the levels exclude the root and pass runs
  const passes = levels.map((level) => level.passRun?.pass ?? null);

  // Descend the current file tree along the node-id path once, up front, so each level's file feeds
  // the taxonomy and no `ref` is resolved twice. The run chain supplies each level's scope.
  const descent = descendNodePath(rootFile, rootDir, files, nodePath);

  for (let level = 0; level < levels.length; level++) {
    const { run: pathRun, scopeRunId, earlierPassRunIds } = levels[level]!;
    const nodeId = pathRun.nodeId!;
    const label = pathRun.nodeName ?? nodeId;
    const isLeaf = level === levels.length - 1;

    // The descent reaches this level whenever every prior level descended, so absence is a divergence.
    const levelInfo = descent.levels[level];
    if (!levelInfo) {
      return refuse(
        409,
        `run "${runId}" resolves to node "${label}", which is no longer in the workflow`,
        "not-in-file",
      );
    }

    // The per-level §5 taxonomy — locate, the leaf's own success, the prefix's — is shared with the
    // client's mirror (`classifyLevelK`); only the leaf gates its own status, and an in-body locus
    // names its enclosing controller.
    const levelResult = classifyLevelK({
      body: levelInfo.file.body,
      rows: sourceRows,
      scopeRunId,
      nodeId,
      leafStatus: isLeaf ? pathRun.status : null,
      earlierPassRunIds,
    });
    if (!levelResult.ok) {
      switch (levelResult.reason) {
        case "not-in-file":
          return refuse(
            409,
            `run "${runId}" resolves to node "${label}", which is no longer in the workflow`,
            "not-in-file",
          );
        case "in-body":
          return refuse(
            400,
            `run "${runId}" resolves to node "${label}", which is inside a ${levelResult.container ?? "loop, parallel, or branch"} body and cannot be a rerun boundary`,
            "in-body",
            levelResult.container,
          );
        case "not-succeeded":
          return refuse(
            409,
            `run "${runId}" (node "${label}") did not succeed; a rerun boundary must be a succeeded node`,
            "not-succeeded",
          );
        case "prefix-unsucceeded":
          return refuse(
            409,
            `run "${runId}" (node "${label}") has an unsucceeded node before it; the whole prefix must succeed to reuse it`,
            "prefix-unsucceeded",
          );
      }
    }

    if (!isLeaf) {
      // An intermediate path-node is descended into; `descendNodePath` reports why it could not be.
      if (descent.miss && descent.miss.atIndex === level) {
        if (descent.miss.reason === "not-workflow") {
          return refuse(
            409,
            `run "${runId}" resolves through node "${label}", which is no longer a nested workflow and cannot be descended`,
            "not-in-file",
          );
        }
        const node = levelInfo.node;
        const ref = node && node.type === "workflow" ? node.ref : "";
        return refuse(
          409,
          `run "${runId}" resolves through node "${label}", whose referenced file "${ref}" is no longer in the workflow`,
          "not-in-file",
        );
      }
    }
  }

  return { ok: true, nodePath, passes };
}
