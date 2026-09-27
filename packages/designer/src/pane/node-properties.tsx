import type { WireStepPlugin } from "@path/client-core";
import {
  CONDITION_ROOTS,
  type Condition,
  type InterpolationRoot,
  PUBLISH_ROOTS,
  STEP_ROOTS,
  type WorkflowFile,
  type WorkflowNode,
} from "@path/schema";
import { ConditionField } from "../condition-builder.js";
import { type EditCommit, type EditKey, editKey } from "../edit-key.js";
import { replaceNode } from "../edit-target.js";
import { editFile, findById, locate, unwrapEdit } from "../edit-tree.js";
import { directionGlyph, gotoTargetOptions } from "../goto-view.js";
import { carriesEnvelope } from "../grammar.js";
import { referenceablePaths } from "../interp-suggest.js";
import { kindExplanation } from "../node-kind.js";
import { fillPlaceholderOnTab, IdRow, SelectField, TextField } from "../pane-controls.js";
import { StepEnvelopeFields } from "./config-region.js";
import { MaxIterationsField, PaneSection } from "./fields.js";
import {
  LeafPayloadEditor,
  PersonActivityEditor,
  PromptEditor,
  WorkflowRefEditor,
} from "./leaf-editors.js";

// ── A selected node's properties ─────────────────────────────────────────────────────────────────

export function NodeProperties({
  file,
  node,
  plugins,
  applyEdit,
  onReselect,
  onAddRefTarget,
}: {
  file: WorkflowFile;
  node: WorkflowNode;
  plugins: WireStepPlugin[];
  applyEdit: EditCommit<WorkflowFile>;
  onReselect: (id: string) => void;
  onAddRefTarget?: (nodeId: string) => void;
}): JSX.Element {
  // A field edit passes its identity so a run of keystrokes folds to one undo entry; a discrete change
  // passes none, so it is its own entry.
  const commit = (next: WorkflowNode, key?: EditKey): void =>
    applyEdit(replaceNode(file, next), key);
  const reKey = (): void => {
    const id = crypto.randomUUID();
    // The one edit found by its *previous* id: the re-key replaces the node that holds `node.id` today.
    applyEdit(replaceNode(file, { ...node, id }, node.id));
    onReselect(id);
  };
  const site = locate(file, node.id);
  const role = occupantRole(site, file);
  const condSuggest = referenceablePaths(file, CONDITION_ROOTS);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: delegated Tab handling for wrapped inputs.
    <div className="pane" onKeyDown={fillPlaceholderOnTab}>
      {role ? (
        <p className="pane-role" role="note">
          {role}
        </p>
      ) : null}
      <p className="pane-explain">{kindExplanation(node.type)}</p>
      <hr className="pane-divider" />
      {/* Identity is the pane's anchor — which node is this — so `name` and `id` never fold away. The
          kind's own fields are a section: they open expanded, and folding them is an option for a busy
          node, never a step before an ordinary edit. */}
      <TextField
        label="name"
        value={node.name}
        onChange={(name) => commit({ ...node, name }, editKey(node.id, "name"))}
      />
      <IdRow id={node.id} onReKey={reKey} what={`"${node.name}"`} />
      <PaneSection key={`fields-${node.id}`} title={node.type} className="pane-fields" defaultOpen>
        {site?.where === "arm" ? (
          <ConditionField
            label="when"
            condition={armWhen(file, site.ownerId, site.armIndex)}
            suggestions={condSuggest}
            identity={editKey(node.id, "when")}
            onChange={(when) =>
              applyEdit(
                unwrapEdit(
                  editFile(file, {
                    kind: "set-arm-when",
                    branchId: site.ownerId,
                    armIndex: site.armIndex,
                    when,
                  }),
                ),
              )
            }
          />
        ) : null}
        <KindFields
          file={file}
          node={node}
          plugins={plugins}
          commit={commit}
          condSuggest={condSuggest}
          onAddRefTarget={onAddRefTarget}
        />
      </PaneSection>
      {carriesEnvelope(node.type) ? (
        <StepEnvelopeFields file={file} node={node} commit={commit} />
      ) : null}
      <ReferenceSection file={file} node={node} site={site} />
    </div>
  );
}

/**
 * The one **Reference** list, at the very end of the pane: the dot-paths this node's interpolable
 * fields may read, the union of its own fields' roots (an arm occupant adds its `when` roots). A node
 * with no interpolable field contributes no roots, so the section does not render.
 */
export function ReferenceSection({
  file,
  node,
  site,
}: {
  file: WorkflowFile;
  node: WorkflowNode;
  site: ReturnType<typeof locate>;
}): JSX.Element | null {
  const roots = new Set<InterpolationRoot>();
  if (site?.where === "arm") for (const root of CONDITION_ROOTS) roots.add(root);
  if (node.type === "while-do") {
    for (const root of CONDITION_ROOTS) roots.add(root);
    for (const root of STEP_ROOTS) roots.add(root);
  } else if (node.type === "checkpoint") {
    for (const root of CONDITION_ROOTS) roots.add(root);
  } else if (carriesEnvelope(node.type)) {
    for (const root of PUBLISH_ROOTS) roots.add(root);
  }
  if (roots.size === 0) return null;
  return <ReferenceList ownerId={node.id} paths={referenceablePaths(file, [...roots])} />;
}

export function ReferenceList({
  ownerId,
  paths,
}: {
  ownerId: string;
  paths: readonly string[];
}): JSX.Element | null {
  if (paths.length === 0) return null;
  return (
    <>
      <hr className="pane-divider" />
      {/* Keyed by the owner: a new selection opens the section collapsed again. */}
      <PaneSection key={ownerId} title="reference" className="pane-reference">
        <p className="pane-hint pane-suggest">{paths.join(" · ")}</p>
      </PaneSection>
    </>
  );
}

/** The `when` condition of a branch arm, read back off the parent branch for the pane's builder. */
export function armWhen(file: WorkflowFile, branchId: string, armIndex: number): Condition {
  const owner = findById(file.body, branchId);
  const when = owner?.type === "branch" ? owner.arms[armIndex]?.when : undefined;
  return when ?? { type: "exists", path: "context.value" };
}

/**
 * The role a node's container gives it (§ Pane layout, orientation before editing). Only a container
 * that distinguishes its occupants supplies one: a branch arm (its 1-based position), a branch `else`,
 * or a parallel branch.
 */
export function occupantRole(site: ReturnType<typeof locate>, file: WorkflowFile): string | null {
  if (!site) return null;
  if (site.where === "else") return "branch else fallback";
  if (site.where === "list" && site.listKind === "branches") return "parallel branch";
  if (site.where === "arm") {
    const owner = findById(file.body, site.ownerId);
    const total = owner?.type === "branch" ? owner.arms.length : 0;
    return `branch arm (${site.armIndex + 1} of ${total})`;
  }
  return null;
}

// ── The kind-specific field region ───────────────────────────────────────────────────────────────

export function KindFields({
  file,
  node,
  plugins,
  commit,
  condSuggest,
  onAddRefTarget,
}: {
  file: WorkflowFile;
  node: WorkflowNode;
  plugins: WireStepPlugin[];
  commit: EditCommit<WorkflowNode>;
  condSuggest: string[];
  onAddRefTarget?: (nodeId: string) => void;
}): JSX.Element {
  // `person-activity` is a plugin leaf outside the core node union, so it is dispatched by string type.
  if ((node.type as string) === "person-activity") {
    return <PersonActivityEditor node={node} commit={commit} />;
  }
  switch (node.type) {
    case "prompt":
      return <PromptEditor file={file} node={node} plugins={plugins} commit={commit} />;
    case "workflow":
      return <WorkflowRefEditor node={node} commit={commit} onAddRefTarget={onAddRefTarget} />;
    case "parallel":
      return (
        <SelectField
          label="join"
          value={node.join}
          options={["collect", "wait-one", "do-not-wait"]}
          onChange={(join) => commit({ ...node, join: join as typeof node.join })}
        />
      );
    case "while-do":
      return (
        <>
          <ConditionField
            label="condition"
            condition={node.condition}
            suggestions={condSuggest}
            identity={editKey(node.id, "condition")}
            onChange={(condition) => commit({ ...node, condition })}
          />
          <MaxIterationsField
            identity={editKey(node.id, "max_iterations")}
            value={node.max_iterations}
            onChange={(v) =>
              commit({ ...node, max_iterations: v }, editKey(node.id, "max_iterations"))
            }
          />
        </>
      );
    case "goto":
      return <GotoEditor file={file} node={node} commit={commit} />;
    case "branch":
      return (
        <p className="pane-hint">
          Arms and else are edited on the canvas; a Branch has no fields of its own.
        </p>
      );
    case "sequence":
      return <p className="pane-hint">Order is structure — reorder the body on the canvas.</p>;
    case "checkpoint":
      return (
        <ConditionField
          label="condition"
          condition={node.condition}
          suggestions={condSuggest}
          identity={editKey(node.id, "condition")}
          onChange={(condition) => commit({ ...node, condition })}
        />
      );
    default:
      return <LeafPayloadEditor file={file} node={node} plugins={plugins} commit={commit} />;
  }
}

/**
 * `goto` — the `target` picker (every first-level node in file order, the goto excluded, each marked
 * `↑`/`↓`) and the mandatory `max_jumps`, which shares `max_iterations`' grammar. A value naming no
 * eligible node stays selected as `missing: <name>` and is never cleared silently.
 */
export function GotoEditor({
  file,
  node,
  commit,
}: {
  file: WorkflowFile;
  node: Extract<WorkflowNode, { type: "goto" }>;
  commit: EditCommit<WorkflowNode>;
}): JSX.Element {
  const options = gotoTargetOptions(file, node.id);
  const eligible = options.some((option) => option.name === node.target);
  const glyphs = new Map(options.map((option) => [option.name, directionGlyph(option.direction)]));
  return (
    <>
      <SelectField
        label="target"
        value={node.target}
        options={
          eligible
            ? options.map((option) => option.name)
            : [node.target, ...options.map((option) => option.name)]
        }
        optionLabel={(name) =>
          glyphs.has(name) ? `${glyphs.get(name)} ${name}` : `missing: ${name === "" ? '""' : name}`
        }
        onChange={(target) => commit({ ...node, target })}
      />
      <MaxIterationsField
        label="max jumps"
        identity={editKey(node.id, "max_jumps")}
        value={node.max_jumps}
        onChange={(v) => commit({ ...node, max_jumps: v }, editKey(node.id, "max_jumps"))}
      />
    </>
  );
}
