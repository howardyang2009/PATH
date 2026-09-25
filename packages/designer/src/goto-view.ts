import { walkNodes, type WorkflowFile } from "@path/schema";
import { findById } from "./edit-tree.js";

/**
 * What the canvas and the pane show of a goto's jump (#619, designer-spec § goto): the canvas draws no
 * edge, so the jump is read off the `target` name. Every derivation here is over **first-level** nodes,
 * because only a first-level node is a legal target (ADR 0056). A goto's own first-level position is the
 * index of the first-level node that holds it (itself, or the `branch` / `sequence` it sits in).
 */

/** `backward` when the target sits at or before the goto's first-level position (a loop), else `forward`. */
export type GotoDirection = "forward" | "backward";

/** One entry of the pane's target picker. */
export interface GotoTargetOption {
  name: string;
  direction: GotoDirection;
}

/** The index of the first-level node holding `id` (the node itself, or its first-level ancestor), or -1. */
function firstLevelIndex(file: WorkflowFile, id: string): number {
  return file.body.findIndex((top) => [...walkNodes([top])].some((node) => node.id === id));
}

/** The direction of a jump from first-level position `from` to first-level position `to`. */
function direction(from: number, to: number): GotoDirection {
  return to <= from ? "backward" : "forward";
}

/**
 * The target picker's entries: every first-level node in file order, the goto itself excluded. The
 * first-level `branch` holding the goto stays eligible, as a backward jump that re-runs it (ADR 0058 §3).
 */
export function gotoTargetOptions(file: WorkflowFile, gotoId: string): GotoTargetOption[] {
  const from = firstLevelIndex(file, gotoId);
  return file.body.flatMap((node, index) => (node.id === gotoId ? [] : [{ name: node.name, direction: direction(from, index) }]));
}

/** The direction glyph a goto's chip wears, or `null` when its target names no first-level node. */
export function gotoDirection(file: WorkflowFile, gotoId: string): GotoDirection | null {
  const node = findById(file.body, gotoId);
  if (node?.type !== "goto") return null;
  const to = file.body.findIndex((top) => top.name === node.target && top.id !== gotoId);
  return to === -1 ? null : direction(firstLevelIndex(file, gotoId), to);
}

/** The glyph for a direction: `↑` for a backward jump, `↓` for a forward one. */
export function directionGlyph(dir: GotoDirection): string {
  return dir === "backward" ? "↑" : "↓";
}

/**
 * The incoming gotos of each first-level node, keyed by its name: the names of the gotos targeting it, in
 * document order. The canvas draws a `← N` badge from it; a name with no first-level node is absent.
 */
export function incomingGotos(file: WorkflowFile): Map<string, string[]> {
  const firstLevel = new Set(file.body.map((node) => node.name));
  const incoming = new Map<string, string[]>();
  for (const node of walkNodes(file.body)) {
    if (node.type !== "goto" || !firstLevel.has(node.target) || node.target === node.name) continue;
    incoming.set(node.target, [...(incoming.get(node.target) ?? []), node.name]);
  }
  return incoming;
}
