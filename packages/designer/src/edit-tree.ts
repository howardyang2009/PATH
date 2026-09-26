import {
  type BranchArm,
  type Condition,
  childBodies,
  gotoIssues,
  mapChildBodies,
  type WorkflowFile,
  type WorkflowNode,
  walkNodes,
} from "@path/schema";

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
 *
 * **The mutation interface is one door: `editFile(file, op)`.** The named transforms below are the
 * private cases it dispatches over; callers name the edit as an `EditOp` and read one `EditResult`
 * (the delete rules are the only ones that can refuse). Locating and querying stay their own exports
 * (`locate`, `findById`, `isDuplicable`), because a reader is not a mutation and carries the module's
 * depth — the recursive tree-walk — on its own.
 *
 * The door also holds the goto rules that no single op can see (#619, designer-spec § goto): an edit that
 * would put a goto under a `while-do` or a `parallel` is **refused** (no follow-up edit could repair it),
 * and a rename rewrites every goto `target` naming the old name in the same edit (one undo step).
 */

// ── The one mutation door ─────────────────────────────────────────────────────────────────────────

/**
 * One structural edit named as data. Each variant carries exactly what its transform needs; the canvas
 * (`editor-api`) and the properties pane build one of these and hand it to {@link editFile}. `move` and
 * `insert-after` name a node by id; the arm/else/list ops name their owner. `delete` is the only variant
 * whose result can refuse (the slot rules).
 */
export type EditOp =
  | { kind: "replace"; id: string; node: WorkflowNode }
  | { kind: "set-arm-when"; branchId: string; armIndex: number; when: Condition }
  | { kind: "add-to-list"; ownerId: string | null; node: WorkflowNode }
  | { kind: "swap-single"; target: SingleSlot; node: WorkflowNode }
  | { kind: "add-arm"; branchId: string; arm: BranchArm }
  | { kind: "add-else"; branchId: string; node: WorkflowNode }
  | { kind: "remove-else"; branchId: string }
  | { kind: "move"; id: string; delta: -1 | 1 }
  | { kind: "insert-after"; id: string; clone: WorkflowNode }
  | { kind: "delete"; id: string };

/**
 * The single entry point for every structural edit: apply `op` to `file` and return the new file, or a
 * refusal (a `delete` that the slot rules forbid, or any edit that misplaces a goto). A no-op op (a move
 * off the end, a replace of an absent id) returns `{ ok: true, file }` with the **same** file reference,
 * so a caller commits only a genuine change (`result.file !== file`).
 */
export function editFile(file: WorkflowFile, op: EditOp): EditResult {
  const result = applyOp(file, op);
  if (!result.ok || result.file === file) return result;
  // Only a goto this edit misplaced refuses it: a draft that already held one is not made uneditable.
  const before = new Set(placedWrong(file));
  const misplaced = placedWrong(result.file).find((id) => !before.has(id));
  if (misplaced !== undefined)
    return { ok: false, reason: "a goto may not sit under a while-do or a parallel" };
  return result;
}

/** The ids of every goto the `@path/schema` rule module refuses for `placement`. */
function placedWrong(file: WorkflowFile): string[] {
  return gotoIssues(file)
    .filter((issue) => issue.rule === "placement")
    .map((issue) => issue.nodeId);
}

function applyOp(file: WorkflowFile, op: EditOp): EditResult {
  switch (op.kind) {
    case "replace":
      return { ok: true, file: replaceNode(file, op.id, op.node) };
    case "set-arm-when":
      return { ok: true, file: setArmWhen(file, op.branchId, op.armIndex, op.when) };
    case "add-to-list":
      return { ok: true, file: addToList(file, op.ownerId, op.node) };
    case "swap-single":
      return { ok: true, file: swapSingleSlot(file, op.target, op.node) };
    case "add-arm":
      return { ok: true, file: addArm(file, op.branchId, op.arm) };
    case "add-else":
      return { ok: true, file: addElse(file, op.branchId, op.node) };
    case "remove-else":
      return { ok: true, file: removeElse(file, op.branchId) };
    case "move":
      return { ok: true, file: moveNode(file, op.id, op.delta) };
    case "insert-after":
      return { ok: true, file: insertAfter(file, op.id, op.clone) };
    case "delete":
      return deleteNode(file, op.id);
  }
}

/**
 * Unwrap an {@link editFile} result the caller knows cannot refuse: an op other than `delete` whose
 * arrival the grammar already admitted (`grammar.socketAcceptsKind`). A refusal here is a bug, so it
 * throws rather than silently dropping the edit. `delete` callers read the `EditResult` directly instead.
 */
export function unwrapEdit(result: EditResult): WorkflowFile {
  if (!result.ok) throw new Error(`edit refused: ${result.reason}`);
  return result.file;
}

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
    const deep = locateWithin(node, id);
    if (deep) return deep;
  }
  return null;
}

/**
 * Locate `id` under `owner`, descending through the one grammar-descent owner (`@path/schema`
 * `childBodies`) rather than re-spelling which slots each node kind has. Each child body carries the
 * JSON `path` that names the slot, so the occupant's `Site` reads straight off that path — no second
 * statement of the block grammar's shape.
 */
function locateWithin(owner: WorkflowNode, id: string): Site | null {
  for (const child of childBodies(owner)) {
    for (let index = 0; index < child.nodes.length; index++) {
      const occupant = child.nodes[index]!;
      if (occupant.id === id) return siteFromPath(owner.id, child.path, index);
      const deep = locateWithin(occupant, id);
      if (deep) return deep;
    }
  }
  return null;
}

/**
 * The `Site` of a child body's occupant, read off the `childBodies` JSON path. A `sequence` `body`
 * carries its whole array, so the occupant's list index is its position within the body; a `parallel`
 * branch, a branch arm, an `else`, and a `while-do` body each carry one node, so their index lives in
 * the path itself (`["branches", i]`, `["arms", i, "node"]`, `["else"]`, `["node"]`).
 */
function siteFromPath(ownerId: string, path: (string | number)[], index: number): Site {
  switch (path[0]) {
    case "body":
      return { where: "list", ownerId, listKind: "sequence-body", index };
    case "branches":
      return { where: "list", ownerId, listKind: "branches", index: path[1] as number };
    case "arms":
      return { where: "arm", ownerId, armIndex: path[1] as number };
    case "else":
      return { where: "else", ownerId };
    default: // "node" — the while-do body
      return { where: "while-body", ownerId };
  }
}

// ── The immutable spine rebuild ───────────────────────────────────────────────────────────────────

/**
 * Rebuild a body, replacing the node with `ownerId` (anywhere in the tree) by `fn(node)`. The spine
 * down to that node is rebuilt; every other node keeps its reference (and its id). `fn` returns a
 * same-identity node, so single-node slots stay length-1 — this is an update primitive, not an insert.
 */
function updateNode(
  body: WorkflowNode[],
  ownerId: string,
  fn: (node: WorkflowNode) => WorkflowNode,
): WorkflowNode[] {
  return body.map((node) => {
    if (node.id === ownerId) return fn(node);
    // Descend through the one grammar-descent owner (`@path/schema` `mapChildBodies`, the write
    // counterpart of `childBodies`), so the spine rebuild states the block grammar's shape nowhere here.
    return mapChildBodies(node, (childBody) => updateNode(childBody, ownerId, fn));
  });
}

/** The file with its body replaced. */
function withBody(file: WorkflowFile, body: WorkflowNode[]): WorkflowFile {
  return { ...file, body };
}

// ── List sockets: the file body, a `sequence` body, a `parallel` branch list ─────────────────────────

/**
 * A position in a node list: the file body (`ownerId` `null`), or the list a `sequence` (`body`) or a
 * `parallel` (`branches`) owns. The one place that says which key holds which owner's list, so add,
 * move, duplicate and delete address a list position without spelling the owner types again.
 */
interface ListSite {
  ownerId: string | null;
  index: number;
}

/** The list site of a located node, or `null` for a single-node slot (an arm, an `else`, a loop body). */
function listSiteOf(site: Site): ListSite | null {
  if (site.where === "file-body") return { ownerId: null, index: site.index };
  if (site.where === "list") return { ownerId: site.ownerId, index: site.index };
  return null;
}

/** The node list `ownerId` holds, or `null` when it is no list owner. */
function listOf(file: WorkflowFile, ownerId: string | null): WorkflowNode[] | null {
  if (ownerId === null) return file.body;
  const owner = findById(file.body, ownerId);
  return owner?.type === "sequence"
    ? owner.body
    : owner?.type === "parallel"
      ? owner.branches
      : null;
}

/** The file with the list `ownerId` holds rebuilt by `fn`; a non-list owner is left unchanged. */
function withList(
  file: WorkflowFile,
  ownerId: string | null,
  fn: (list: WorkflowNode[]) => WorkflowNode[],
): WorkflowFile {
  if (ownerId === null) return withBody(file, fn(file.body));
  return withBody(
    file,
    updateNode(file.body, ownerId, (owner) => {
      if (owner.type === "sequence") return { ...owner, body: fn(owner.body) };
      if (owner.type === "parallel") return { ...owner, branches: fn(owner.branches) };
      return owner;
    }),
  );
}

// ── Replace a node's content in place ───────────────────────────────────────────────────────────

/**
 * Replace the node `id` (anywhere in the tree) by `next`, keeping its position and its container's
 * shape. This is the properties pane's commit primitive (#369): the pane hands back a whole new node
 * object with the edited content, and the spine down to it is rebuilt while every sibling keeps its
 * reference. Unlike the structure ops, this one **may change the node's own `id`** — the pane's
 * confirmation-gated re-key (ADR 0015) passes a `next` carrying a fresh id — so the match is on the
 * *old* `id` and the replacement is whatever `next` carries. A missing `id` is a no-op.
 *
 * A rename of a first-level node rewrites every goto `target` naming the old name, in the same edit
 * (#619, ADR 0056 §7). The pane commits a rename per keystroke, so the rewrite runs only when it cannot
 * mis-aim: the old name was this node's alone (not a name shared mid-typing with another node) and the
 * new name is free and non-empty (`""` is a fresh goto's "no target yet", never a link). Otherwise
 * nothing is rewritten and the goto keeps its old target, which the goto markers then flag, so a lost
 * link is visible, never a silent repoint to some other node.
 */
function replaceNode(file: WorkflowFile, id: string, next: WorkflowNode): WorkflowFile {
  const previous = findById(file.body, id);
  if (!previous) return file;
  const body = updateNode(file.body, id, () => next);
  return withBody(
    file,
    renames(file, previous, next) ? retarget(body, previous.name, next.name) : body,
  );
}

/** Is replacing `previous` by `next` a rename whose gotos can safely follow it? */
function renames(file: WorkflowFile, previous: WorkflowNode, next: WorkflowNode): boolean {
  if (previous.name === next.name || previous.name === "" || next.name === "") return false;
  if (!file.body.some((node) => node.id === previous.id)) return false; // only a first-level node is a target
  const names = [...walkNodes(file.body)].map((node) => node.name);
  return names.filter((name) => name === previous.name).length === 1 && !names.includes(next.name);
}

/** Point every goto whose `target` is `from` at `to`. A body with no such goto comes back unchanged. */
function retarget(body: WorkflowNode[], from: string, to: string): WorkflowNode[] {
  if (![...walkNodes(body)].some((node) => node.type === "goto" && node.target === from))
    return body;
  return body.map((node) =>
    node.type === "goto"
      ? node.target === from
        ? { ...node, target: to }
        : node
      : mapChildBodies(node, (child) => retarget(child, from, to)),
  );
}

/**
 * Set a branch arm's `when` condition, keeping its occupant node untouched (#370, designer-spec
 * § Structure on the canvas, content in the pane). An arm owns its `when` (not the Branch node), and the
 * pane edits it while the arm's **occupant** is selected — so the commit lands on the parent branch's
 * `arms[armIndex].when`, not on the selected node. A missing branch, a non-branch owner, or an
 * out-of-range arm is a no-op.
 */
function setArmWhen(
  file: WorkflowFile,
  branchId: string,
  armIndex: number,
  when: Condition,
): WorkflowFile {
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
function addToList(file: WorkflowFile, ownerId: string | null, node: WorkflowNode): WorkflowFile {
  return withList(file, ownerId, (list) => [...list, node]);
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
function swapSingleSlot(file: WorkflowFile, target: SingleSlot, node: WorkflowNode): WorkflowFile {
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
function addArm(file: WorkflowFile, branchId: string, arm: BranchArm): WorkflowFile {
  return withBody(
    file,
    updateNode(file.body, branchId, (owner) =>
      owner.type === "branch" ? { ...owner, arms: [...owner.arms, arm] } : owner,
    ),
  );
}

/** Add an `else` to a `branch` that has none (there is at most one `else`); a no-op if one exists. */
function addElse(file: WorkflowFile, branchId: string, node: WorkflowNode): WorkflowFile {
  return withBody(
    file,
    updateNode(file.body, branchId, (owner) =>
      owner.type === "branch" && !owner.else ? { ...owner, else: node } : owner,
    ),
  );
}

/** Remove a `branch`'s `else` (the add-`else` affordance returns after). */
function removeElse(file: WorkflowFile, branchId: string): WorkflowFile {
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
function moveNode(file: WorkflowFile, id: string, delta: -1 | 1): WorkflowFile {
  const site = locate(file, id);
  if (!site) return file;

  // Guard the bounds against the list *before* rebuilding — an off-the-end move must return the same file
  // reference, so it never marks the buffer edited (the caller commits any new reference it hands back).
  const listSite = listSiteOf(site);
  if (listSite) {
    const list = listOf(file, listSite.ownerId);
    if (!list || listSite.index + delta < 0 || listSite.index + delta >= list.length) return file;
    return withList(
      file,
      listSite.ownerId,
      (l) => swapAt(l, listSite.index, listSite.index + delta) ?? l,
    );
  }
  if (site.where === "arm") {
    const owner = findById(file.body, site.ownerId);
    if (
      owner?.type !== "branch" ||
      site.armIndex + delta < 0 ||
      site.armIndex + delta >= owner.arms.length
    )
      return file;
    return withBody(
      file,
      updateNode(file.body, site.ownerId, (o) =>
        o.type === "branch"
          ? { ...o, arms: swapAt(o.arms, site.armIndex, site.armIndex + delta) ?? o.arms }
          : o,
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
export type EditResult = { ok: true; file: WorkflowFile } | { ok: false; reason: string };

/**
 * Delete the node `id`, applying the slot rules that keep the tree legal (§ Delete):
 * - a **file-body** node is removed (the root list may empty to the start-a-body canvas);
 * - a **`sequence` body** node is removed, and an emptied sequence is itself deleted (cascading up);
 * - a **`parallel` branch** or a **branch arm** cannot be the last one (a refusal, must keep ≥1);
 * - a **`while-do` body** node deletes the whole loop;
 * - a **branch `else`** occupant removes the `else`.
 */
function deleteNode(file: WorkflowFile, id: string): EditResult {
  const site = locate(file, id);
  if (!site) return { ok: false, reason: "node not found" };

  switch (site.where) {
    case "file-body":
    case "list": {
      // The list rules: the file body may empty; a `parallel` must keep one branch; an emptied `sequence`
      // is itself deleted (cascading up).
      const { ownerId, index } = listSiteOf(site)!;
      const list = listOf(file, ownerId);
      if (ownerId !== null && list !== null && list.length <= 1) {
        if (site.where === "list" && site.listKind === "branches")
          return { ok: false, reason: "a parallel must keep at least one branch" };
        return deleteNode(file, ownerId);
      }
      return { ok: true, file: withList(file, ownerId, (l) => removeAt(l, index)) };
    }

    case "arm":
      return removeArm(file, site.ownerId, site.armIndex);

    case "else":
      return { ok: true, file: removeElse(file, site.ownerId) };

    case "while-body":
      // Deleting the body deletes the loop — recurse on the `while-do` node itself.
      return deleteNode(file, site.ownerId);
  }
}

/** Remove arm `armIndex` from a `branch`, refusing when it is the last arm (a branch must keep ≥1). */
function removeArm(file: WorkflowFile, branchId: string, armIndex: number): EditResult {
  const owner = findById(file.body, branchId);
  if (owner?.type === "branch" && owner.arms.length <= 1)
    return { ok: false, reason: "a branch must keep at least one arm" };
  return {
    ok: true,
    file: withBody(
      file,
      updateNode(file.body, branchId, (o) =>
        o.type === "branch" ? { ...o, arms: removeAt(o.arms, armIndex) } : o,
      ),
    ),
  };
}

/** A copy of `list` without index `i`. */
function removeAt<T>(list: T[], i: number): T[] {
  return list.filter((_, index) => index !== i);
}

/**
 * Find a node by id anywhere in a body, or `null` if it is not present. The one node-by-id lookup —
 * the sibling of `locate` (which returns the *site*), for callers that want the *node*. It reads the
 * one grammar-descent owner (`@path/schema` `walkNodes`), so it re-spells the block grammar's shape
 * nowhere of its own.
 */
export function findById(body: WorkflowNode[], id: string): WorkflowNode | null {
  for (const node of walkNodes(body)) {
    if (node.id === id) return node;
  }
  return null;
}

// ── Duplicate a list node ─────────────────────────────────────────────────────────────────────────

/**
 * Insert `clone` (a fresh-identity copy, minted by `node-factory.cloneWithFreshIdentity`) directly
 * after the node `id` in its list. Only a list node (file body, `sequence` body, `parallel` branches)
 * can be duplicated — a single-slot occupant has no list to grow — so a non-list `id` is a no-op.
 */
function insertAfter(file: WorkflowFile, id: string, clone: WorkflowNode): WorkflowFile {
  const site = locate(file, id);
  const listSite = site && listSiteOf(site);
  if (!listSite) return file;
  return withList(file, listSite.ownerId, (list) => spliceAfter(list, listSite.index, clone));
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
  return site !== null && listSiteOf(site) !== null;
}
