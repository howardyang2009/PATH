import type { BranchArm, Condition, WorkflowFile, WorkflowNode } from "@path/schema";

/**
 * The pure structure edits the canvas performs on a `WorkflowFile` body (#368, designer-spec § Adding,
 * reordering, deleting). Every function here is a pure transform: it takes a file and returns a **new**
 * file, and it **preserves every node `id`** across a move, a reorder, and a reparent (ADR 0015) — the
 * moved node keeps its object reference, so its id is untouched. Only a fresh add or a duplicate mints a
 * new id, and that happens in `node-factory.ts`, not here.
 *
 * The slot rules that keep the tree legal (§ Delete) live in `deleteNode`: deleting a `while-do` body
 * deletes the loop; the last `parallel` branch or branch arm cannot be deleted (must keep ≥1); emptying
 * a `sequence` deletes the sequence; the file-body root is never deleted (removing its last node just
 * empties the canvas). A single-node slot never empties — it **swaps** (`swapSingleSlot`).
 */

// ── Locating a node and its container ─────────────────────────────────────────────────────────────

/** Where a node sits in the tree — the context its delete/move/duplicate rules depend on. */
export type Site =
  /** A top-level node in the file body (the undeletable root list). */
  | { where: "file-body"; index: number }
  /** An element of a `sequence` body or a `parallel` branch list. */
  | { where: "list"; ownerId: string; listKind: "sequence-body" | "branches"; index: number }
  /** A branch arm's single occupant (the arm at `armIndex` of branch `ownerId`). */
  | { where: "arm"; ownerId: string; armIndex: number }
  /** A branch's `else` single occupant. */
  | { where: "else"; ownerId: string }
  /** A `while-do` body's single occupant. */
  | { where: "while-body"; ownerId: string };

/** Find `id` in the file and describe where it sits, or `null` if it is not present. */
export function locate(file: WorkflowFile, id: string): Site | null {
  for (let i = 0; i < file.body.length; i++) {
    const node = file.body[i]!;
    if (node.id === id) return { where: "file-body", index: i };
    const deep = locateInChildren(node, id);
    if (deep) return deep;
  }
  return null;
}

function locateInChildren(node: WorkflowNode, id: string): Site | null {
  switch (node.type) {
    case "sequence":
      return locateInList(node.body, id, node.id, "sequence-body");
    case "parallel":
      return locateInList(node.branches, id, node.id, "branches");
    case "while-do":
      if (node.node.id === id) return { where: "while-body", ownerId: node.id };
      return locateInChildren(node.node, id);
    case "branch": {
      for (let i = 0; i < node.arms.length; i++) {
        const occupant = node.arms[i]!.node;
        if (occupant.id === id) return { where: "arm", ownerId: node.id, armIndex: i };
        const deep = locateInChildren(occupant, id);
        if (deep) return deep;
      }
      if (node.else) {
        if (node.else.id === id) return { where: "else", ownerId: node.id };
        return locateInChildren(node.else, id);
      }
      return null;
    }
    default:
      return null;
  }
}

function locateInList(list: WorkflowNode[], id: string, ownerId: string, listKind: "sequence-body" | "branches"): Site | null {
  for (let i = 0; i < list.length; i++) {
    const node = list[i]!;
    if (node.id === id) return { where: "list", ownerId, listKind, index: i };
    const deep = locateInChildren(node, id);
    if (deep) return deep;
  }
  return null;
}

// ── The immutable spine rebuild ───────────────────────────────────────────────────────────────────

/**
 * Rebuild a body, replacing the node with `ownerId` (anywhere in the tree) by `fn(node)`. The spine
 * down to that node is rebuilt; every other node keeps its reference (and its id). `fn` returns a
 * same-identity node, so single-node slots stay length-1 — this is an update primitive, not an insert.
 */
function updateNode(body: WorkflowNode[], ownerId: string, fn: (node: WorkflowNode) => WorkflowNode): WorkflowNode[] {
  return body.map((node) => {
    if (node.id === ownerId) return fn(node);
    return mapChildBodies(node, (childBody) => updateNode(childBody, ownerId, fn));
  });
}

/** Reconstruct `node` with each of its child bodies passed through `fn`, preserving the node's own fields. */
function mapChildBodies(node: WorkflowNode, fn: (body: WorkflowNode[]) => WorkflowNode[]): WorkflowNode {
  switch (node.type) {
    case "sequence":
      return { ...node, body: fn(node.body) };
    case "parallel":
      return { ...node, branches: fn(node.branches) };
    case "while-do":
      return { ...node, node: fn([node.node])[0]! };
    case "branch": {
      const arms = node.arms.map((arm) => ({ ...arm, node: fn([arm.node])[0]! }));
      const elseNode = node.else ? fn([node.else])[0]! : undefined;
      return { ...node, arms, else: elseNode };
    }
    default:
      return node;
  }
}

/** The file with its body replaced. */
function withBody(file: WorkflowFile, body: WorkflowNode[]): WorkflowFile {
  return { ...file, body };
}

// ── Replace a node's content in place ───────────────────────────────────────────────────────────

/**
 * Replace the node `id` (anywhere in the tree) by `next`, keeping its position and its container's
 * shape. This is the properties pane's commit primitive (#369): the pane hands back a whole new node
 * object with the edited content, and the spine down to it is rebuilt while every sibling keeps its
 * reference. Unlike the structure ops, this one **may change the node's own `id`** — the pane's
 * confirmation-gated re-key (ADR 0015) passes a `next` carrying a fresh id — so the match is on the
 * *old* `id` and the replacement is whatever `next` carries. A missing `id` is a no-op.
 */
export function replaceNode(file: WorkflowFile, id: string, next: WorkflowNode): WorkflowFile {
  if (!locate(file, id)) return file;
  return withBody(file, updateNode(file.body, id, () => next));
}

/**
 * Set a branch arm's `when` condition, keeping its occupant node untouched (#370, designer-spec
 * § Structure on the canvas, content in the pane). An arm owns its `when` (not the Branch node), and the
 * pane edits it while the arm's **occupant** is selected — so the commit lands on the parent branch's
 * `arms[armIndex].when`, not on the selected node. A missing branch, a non-branch owner, or an
 * out-of-range arm is a no-op.
 */
export function setArmWhen(file: WorkflowFile, branchId: string, armIndex: number, when: Condition): WorkflowFile {
  return withBody(
    file,
    updateNode(file.body, branchId, (owner) => {
      if (owner.type !== "branch" || armIndex < 0 || armIndex >= owner.arms.length) return owner;
      const arms = owner.arms.map((arm, i) => (i === armIndex ? { ...arm, when } : arm));
      return { ...owner, arms };
    }),
  );
}

// ── Add into a list socket ────────────────────────────────────────────────────────────────────────

/**
 * Append `node` to a list socket: the file body (`ownerId` `null`), a `sequence` body, or a `parallel`
 * branch list (each a `WorkflowNode[]`). The caller has already checked the socket admits the node's
 * kind (`grammar.socketAcceptsKind`); an illegal kind never reaches here.
 */
export function addToList(file: WorkflowFile, ownerId: string | null, node: WorkflowNode): WorkflowFile {
  if (ownerId === null) return withBody(file, [...file.body, node]);
  return withBody(
    file,
    updateNode(file.body, ownerId, (owner) => {
      if (owner.type === "sequence") return { ...owner, body: [...owner.body, node] };
      if (owner.type === "parallel") return { ...owner, branches: [...owner.branches, node] };
      return owner;
    }),
  );
}

// ── Swap a single-node slot ───────────────────────────────────────────────────────────────────────

/** A single-node slot the canvas can swap: a `while-do` body, a branch arm occupant, or a branch `else`. */
export type SingleSlot =
  | { slot: "while-body"; ownerId: string }
  | { slot: "arm"; ownerId: string; armIndex: number }
  | { slot: "else"; ownerId: string };

/**
 * Swap a single-node slot's occupant for `node`, never emptying the slot (§ Replace a single-node
 * slot). The former occupant is discarded; the slot stays occupied. A checkpoint never reaches here —
 * the grammar refuses it at a single slot (`grammar.socketAcceptsKind`).
 */
export function swapSingleSlot(file: WorkflowFile, target: SingleSlot, node: WorkflowNode): WorkflowFile {
  return withBody(
    file,
    updateNode(file.body, target.ownerId, (owner) => {
      if (target.slot === "while-body" && owner.type === "while-do") return { ...owner, node };
      if (target.slot === "else" && owner.type === "branch") return { ...owner, else: node };
      if (target.slot === "arm" && owner.type === "branch") {
        const arms = owner.arms.map((arm, i) => (i === target.armIndex ? { ...arm, node } : arm));
        return { ...owner, arms };
      }
      return owner;
    }),
  );
}

// ── Branch arm and else management ────────────────────────────────────────────────────────────────

/** Append a new arm to a `branch` (§ Adding; the arm carries its own `when` and occupant). */
export function addArm(file: WorkflowFile, branchId: string, arm: BranchArm): WorkflowFile {
  return withBody(
    file,
    updateNode(file.body, branchId, (owner) => (owner.type === "branch" ? { ...owner, arms: [...owner.arms, arm] } : owner)),
  );
}

/** Add an `else` to a `branch` that has none (there is at most one `else`); a no-op if one exists. */
export function addElse(file: WorkflowFile, branchId: string, node: WorkflowNode): WorkflowFile {
  return withBody(
    file,
    updateNode(file.body, branchId, (owner) => (owner.type === "branch" && !owner.else ? { ...owner, else: node } : owner)),
  );
}

/** Remove a `branch`'s `else` (the add-`else` affordance returns after). */
export function removeElse(file: WorkflowFile, branchId: string): WorkflowFile {
  return withBody(
    file,
    updateNode(file.body, branchId, (owner) => {
      if (owner.type !== "branch") return owner;
      const { else: _dropped, ...rest } = owner;
      return rest;
    }),
  );
}

// ── Reorder within a container ────────────────────────────────────────────────────────────────────

/**
 * Move a node one place up (`-1`) or down (`+1`) within its container, preserving its `id` (ADR 0015).
 * A list element reorders in its list; a branch **arm** occupant reorders the arms (order is
 * first-match-wins). A single-node slot (`while-do` body, `else`) has no siblings, so a move there is a
 * no-op that returns the same file. A move off either end is a no-op too.
 */
export function moveNode(file: WorkflowFile, id: string, delta: -1 | 1): WorkflowFile {
  const site = locate(file, id);
  if (!site) return file;

  if (site.where === "file-body") {
    const swapped = swapAt(file.body, site.index, site.index + delta);
    return swapped ? withBody(file, swapped) : file;
  }
  // For a list/arm move, guard the bounds against the owner *before* rebuilding — an off-the-end move
  // must return the same file reference, so it never marks the buffer edited (the caller commits any
  // new reference `moveNode` hands back).
  if (site.where === "list") {
    const owner = findById(file.body, site.ownerId);
    const list = owner?.type === "sequence" ? owner.body : owner?.type === "parallel" ? owner.branches : null;
    if (!list || site.index + delta < 0 || site.index + delta >= list.length) return file;
    return withBody(
      file,
      updateNode(file.body, site.ownerId, (o) => {
        if (o.type === "sequence") return { ...o, body: swapAt(o.body, site.index, site.index + delta) ?? o.body };
        if (o.type === "parallel") return { ...o, branches: swapAt(o.branches, site.index, site.index + delta) ?? o.branches };
        return o;
      }),
    );
  }
  if (site.where === "arm") {
    const owner = findById(file.body, site.ownerId);
    if (owner?.type !== "branch" || site.armIndex + delta < 0 || site.armIndex + delta >= owner.arms.length) return file;
    return withBody(
      file,
      updateNode(file.body, site.ownerId, (o) =>
        o.type === "branch" ? { ...o, arms: swapAt(o.arms, site.armIndex, site.armIndex + delta) ?? o.arms } : o,
      ),
    );
  }
  return file; // while-body / else: a single slot, no reorder
}

/** A copy of `list` with the elements at `i` and `j` swapped, or `null` if `j` is out of range. */
function swapAt<T>(list: T[], i: number, j: number): T[] | null {
  if (j < 0 || j >= list.length) return null;
  const next = list.slice();
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

// ── Delete, with the slot rules ───────────────────────────────────────────────────────────────────

/** The outcome of a delete: the new file, or a refusal naming why the node cannot go. */
export type DeleteResult = { ok: true; file: WorkflowFile } | { ok: false; reason: string };

/**
 * Delete the node `id`, applying the slot rules that keep the tree legal (§ Delete):
 * - a **file-body** node is removed (the root list may empty to the start-a-body canvas);
 * - a **`sequence` body** node is removed, and an emptied sequence is itself deleted (cascading up);
 * - a **`parallel` branch** or a **branch arm** cannot be the last one (a refusal, must keep ≥1);
 * - a **`while-do` body** node deletes the whole loop;
 * - a **branch `else`** occupant removes the `else`.
 */
export function deleteNode(file: WorkflowFile, id: string): DeleteResult {
  const site = locate(file, id);
  if (!site) return { ok: false, reason: "node not found" };

  switch (site.where) {
    case "file-body":
      return { ok: true, file: withBody(file, removeAt(file.body, site.index)) };

    case "list":
      if (site.listKind === "branches") {
        return removeFromOwnerList(file, site.ownerId, site.index, "parallel", "a parallel must keep at least one branch");
      }
      return removeFromSequence(file, site.ownerId, site.index);

    case "arm":
      return removeArm(file, site.ownerId, site.armIndex);

    case "else":
      return { ok: true, file: removeElse(file, site.ownerId) };

    case "while-body":
      // Deleting the body deletes the loop — recurse on the `while-do` node itself.
      return deleteNode(file, site.ownerId);
  }
}

/** Remove index `i` from a `parallel`/`sequence` owner's list, refusing when it would leave the list empty. */
function removeFromOwnerList(file: WorkflowFile, ownerId: string, index: number, ownerType: "parallel", reason: string): DeleteResult {
  const owner = findById(file.body, ownerId);
  if (owner?.type === ownerType && owner.branches.length <= 1) return { ok: false, reason };
  return {
    ok: true,
    file: withBody(
      file,
      updateNode(file.body, ownerId, (o) => (o.type === "parallel" ? { ...o, branches: removeAt(o.branches, index) } : o)),
    ),
  };
}

/** Remove index `i` from a `sequence` body; if that empties the sequence, delete the sequence itself (cascade). */
function removeFromSequence(file: WorkflowFile, sequenceId: string, index: number): DeleteResult {
  const owner = findById(file.body, sequenceId);
  if (owner?.type === "sequence" && owner.body.length <= 1) {
    return deleteNode(file, sequenceId);
  }
  return {
    ok: true,
    file: withBody(
      file,
      updateNode(file.body, sequenceId, (o) => (o.type === "sequence" ? { ...o, body: removeAt(o.body, index) } : o)),
    ),
  };
}

/** Remove arm `armIndex` from a `branch`, refusing when it is the last arm (a branch must keep ≥1). */
function removeArm(file: WorkflowFile, branchId: string, armIndex: number): DeleteResult {
  const owner = findById(file.body, branchId);
  if (owner?.type === "branch" && owner.arms.length <= 1) return { ok: false, reason: "a branch must keep at least one arm" };
  return {
    ok: true,
    file: withBody(
      file,
      updateNode(file.body, branchId, (o) => (o.type === "branch" ? { ...o, arms: removeAt(o.arms, armIndex) } : o)),
    ),
  };
}

/** A copy of `list` without index `i`. */
function removeAt<T>(list: T[], i: number): T[] {
  return list.filter((_, index) => index !== i);
}

/**
 * Find a node by id anywhere in a body, or `null` if it is not present. The one node-by-id lookup —
 * the sibling of `locate` (which returns the *site*), for callers that want the *node* — so no reader
 * re-spells `[...walkNodes(body)].find(n => n.id === id)`.
 */
export function findById(body: WorkflowNode[], id: string): WorkflowNode | null {
  for (const node of body) {
    if (node.id === id) return node;
    const deep = mapFind(node, id);
    if (deep) return deep;
  }
  return null;
}

function mapFind(node: WorkflowNode, id: string): WorkflowNode | null {
  switch (node.type) {
    case "sequence":
      return findById(node.body, id);
    case "parallel":
      return findById(node.branches, id);
    case "while-do":
      return findById([node.node], id);
    case "branch": {
      const inArms = findById(node.arms.map((arm) => arm.node), id);
      if (inArms) return inArms;
      return node.else ? findById([node.else], id) : null;
    }
    default:
      return null;
  }
}

// ── Duplicate a list node ─────────────────────────────────────────────────────────────────────────

/**
 * Insert `clone` (a fresh-identity copy, minted by `node-factory.cloneWithFreshIdentity`) directly
 * after the node `id` in its list. Only a list node (file body, `sequence` body, `parallel` branches)
 * can be duplicated — a single-slot occupant has no list to grow — so a non-list `id` is a no-op.
 */
export function insertAfter(file: WorkflowFile, id: string, clone: WorkflowNode): WorkflowFile {
  const site = locate(file, id);
  if (!site) return file;
  if (site.where === "file-body") return withBody(file, spliceAfter(file.body, site.index, clone));
  if (site.where === "list") {
    return withBody(
      file,
      updateNode(file.body, site.ownerId, (owner) => {
        if (owner.type === "sequence") return { ...owner, body: spliceAfter(owner.body, site.index, clone) };
        if (owner.type === "parallel") return { ...owner, branches: spliceAfter(owner.branches, site.index, clone) };
        return owner;
      }),
    );
  }
  return file;
}

/** A copy of `list` with `item` inserted just after index `i`. */
function spliceAfter<T>(list: T[], i: number, item: T): T[] {
  const next = list.slice();
  next.splice(i + 1, 0, item);
  return next;
}

/** Can the node `id` be duplicated? Only list nodes (they have a list to grow into). */
export function isDuplicable(file: WorkflowFile, id: string): boolean {
  const site = locate(file, id);
  return site?.where === "file-body" || site?.where === "list";
}
