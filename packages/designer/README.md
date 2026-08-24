# @path/designer

The **authoring** console for PATH workflows — the surface where a `path/workflow@2` file is *written*,
counterpart to the read-only [`@path/viewer`](../viewer) where runs are *watched*. Part of
[wayfinder map #254](https://github.com/howardyang2009/PATH/issues/254).

## Status

**Not yet built.** The package is being specified decision-by-decision before any app code lands; the
contract accrues in [`docs/spec/designer-spec.md`](../../docs/spec/designer-spec.md), normative only for
the sections present. So far: the [edit-lock lease protocol](../../docs/spec/designer-spec.md#edit-lock-lease-protocol)
([#258](https://github.com/howardyang2009/PATH/issues/258)) and the
[canvas interaction model](../../docs/spec/designer-spec.md#canvas-interaction-model)
([#255](https://github.com/howardyang2009/PATH/issues/255)).

## Prototype

[`canvas.prototype.html`](./canvas.prototype.html) is a **throwaway** prototype (no build, no server, no
persistence — double-click to open) that settled the constrained-canvas interaction model for
[#255](https://github.com/howardyang2009/PATH/issues/255). It carries three switchable variants —
drill-down, inline-Scratch, and the chosen **hybrid** — over one sample workflow, and answers the
ticket's open questions (parallel join modes, where conditions live, mandatory while-do max-iterations,
inline checkpoints, spatial sequence order, depth-3+ readability, the add-node gesture). Its validated
decisions are folded into the spec above; the file is kept as the **primary source** behind them.

The **fully-iterated prototype is on `main`** — this in-tree file — merged via
[#305](https://github.com/howardyang2009/PATH/pull/305). Its development branch
[`proto/designer-canvas-255`](https://github.com/howardyang2009/PATH/tree/proto/designer-canvas-255)
is kept as the primary-source history (and as the target of the spec's blob links); it is not deleted.
