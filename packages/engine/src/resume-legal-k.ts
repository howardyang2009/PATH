import {
  type ControlBlockKind,
  type LegalKBoundaryReason,
  legalKBoundary,
  must,
  type RunRecord,
  selectBoundary,
  type WorkflowFile,
} from "@path/schema";
import { descendNodePath } from "./descend-node-path.js";
import { type CodedRefusal, refusal } from "./failure.js";

/**
 * The legal-K authority for Resume-from-chosen-K (spec §5, ADR 0032/0036): resolves the source run
 * id to the rerun-boundary (K) node-id descent path and validates it against the current file, so
 * `--from` and `--list-eligible` can never disagree. The law itself — the selection facts, the
 * per-level order and the two ways a nested `ref` stops the descent — is `@path/schema`'s
 * `legalKBoundary`; this module supplies the one thing the engine has and a surface may not: the
 * loaded file tree the descent reads, and the code and status each reason takes at the CLI and
 * the HTTP door.
 *
 * Refusals, first failure wins: run in no run of the tree (400), deleted node or unsucceeded
 * K/prefix (409), illegal locus in a loop/parallel/branch body (400). Each reason's code is
 * `run.resume.k.<reason>`, whose catalogue message is the one wording every surface shows.
 */

/**
 * The §5 taxonomy classification of a refusal, exposed so a surface can render a short reason
 * without re-deriving it from the `message` text — the `--list-eligible` column (spec §6).
 */
export type LegalKReasonCode = LegalKBoundaryReason;

/**
 * The innermost enclosing controller named in an `in-body` refusal (spec §6); an alias for
 * `@path/schema`'s `ControlBlockKind`, shared with the client's mirror.
 */
export type LegalKContainer = ControlBlockKind;

/** A legal-K refusal: the HTTP status, its error code and English message, and the §5 taxonomy
 * reason code. */
export interface LegalKRefusal extends CodedRefusal {
  status: number;
  reason: LegalKReasonCode;
  /** Only on `reason: "in-body"`: the innermost enclosing controller, so the listing can name
   * it. */
  container?: LegalKContainer;
}

/**
 * A legal K: the node-id descent path root→…→K, and level for level the goto pass each path-node
 * sits in (ADR 0054 §6), `null` where the file holds no goto.
 */
export type LegalKResult =
  | { ok: true; nodePath: string[]; passes: (number | null)[] }
  | { ok: false; refusal: LegalKRefusal };

/** Which status a reason takes: a bad selection or locus is the operator's `400`; a node the file no
 * longer holds, an unsucceeded K or prefix, or a broken nested `ref` is the `409` of a tree that
 * moved on. */
function statusFor(reason: LegalKReasonCode): number {
  switch (reason) {
    case "not-in-tree":
    case "root-run":
    case "pass-run":
    case "in-body":
      return 400;
    case "not-in-file":
    case "not-succeeded":
    case "prefix-unsucceeded":
    case "not-workflow":
    case "ref-unresolved":
      return 409;
  }
}

/**
 * Resolve `runId` against the raw source tree `sourceRows` — the predecessor's own rows, not the
 * reuse-swapped plan input, since the taxonomy reads its recorded statuses — and the current
 * `rootFile`/`rootDir` (with `files` for a nested K), returning the boundary node-id path or a
 * refusal.
 */
export function resolveLegalK(
  rootFile: WorkflowFile,
  sourceRows: RunRecord[],
  runId: string,
  files: Map<string, WorkflowFile>,
  rootDir: string,
): LegalKResult {
  // The descent path comes from the selection (a node's run, never the root or a pass container);
  // the descent along the current file tree is the engine's, and its own miss says which level
  // stopped it. Everything after that is the shared verdict's.
  const selection = selectBoundary(sourceRows, runId);
  const nodePath =
    selection.kind === "node"
      ? selection.levels.map((level) => must(level.run.nodeId, "node id of a boundary level"))
      : undefined;
  const descent =
    nodePath === undefined ? undefined : descendNodePath(rootFile, rootDir, files, nodePath);
  const verdict = legalKBoundary(
    sourceRows,
    runId,
    descent === undefined
      ? { bodies: [] }
      : {
          bodies: descent.levels.map((level) => level.file.body),
          ...(descent.miss === undefined
            ? {}
            : {
                stoppedAt: {
                  index: descent.miss.atIndex,
                  reason:
                    descent.miss.reason === "not-workflow" ? "not-workflow" : "ref-unresolved",
                },
              }),
        },
  );
  if (verdict.ok) return { ok: true, nodePath: verdict.nodePath, passes: verdict.passes };

  const { reason, nodeName, container, pass, ref } = verdict.refusal;
  return {
    ok: false,
    refusal: {
      status: statusFor(reason),
      ...refusal(`run.resume.k.${reason}`, {
        runId,
        label: nodeName ?? runId,
        pass: String(pass),
        ref: ref ?? "",
        container: container ?? "",
      }),
      reason,
      ...(container ? { container } : {}),
    },
  };
}
