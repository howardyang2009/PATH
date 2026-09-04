# @path/designer

The **authoring** console for PATH workflows — the surface where a `path/workflow@2` file is *written*,
counterpart to the read-only [`@path/viewer`](../viewer) where runs are *watched*. Part of
[wayfinder map #254](https://github.com/howardyang2009/PATH/issues/254).

## Status

**Tracer bullet.** The buildable, servable bundle now exists ([#366](https://github.com/howardyang2009/PATH/issues/366)):
a Vite + React app that builds to `dist` with `base: "/designer/"` and loads at `/designer/` on
`path-server` (the mount from [#360](https://github.com/howardyang2009/PATH/issues/360), ADR 0027). It
is a peer of [`@path/viewer`](../viewer) over the same [`@path/client-core`](../client-core); it depends
on the Viewer and reuses its three run read panels (ADR 0031), while keeping its own authoring shell. The
page is an **empty canvas** plus a **static palette shell** (Steps +
Blocks); the Steps list is a placeholder for the registry-driven list a later ticket wires from
`GET /v0/step-plugins`. No open, save, or run yet.

Run it against a live `path-server`:

```
pnpm --filter @path/designer dev   # Vite dev server, proxies /v0/* to path-server
pnpm --filter @path/designer build # → packages/designer/dist, served at /designer/
```

The contract accrues in [`docs/spec/designer-spec.md`](../../docs/spec/designer-spec.md), normative only
for the sections present: the [edit-lock lease protocol](../../docs/spec/designer-spec.md#edit-lock-lease-protocol)
([#258](https://github.com/howardyang2009/PATH/issues/258)), the
[canvas interaction model](../../docs/spec/designer-spec.md#canvas-interaction-model)
([#255](https://github.com/howardyang2009/PATH/issues/255)), and the
[v1 authoring palette](../../docs/spec/designer-spec.md#the-v1-authoring-palette)
([#261](https://github.com/howardyang2009/PATH/issues/261)).

## Prototype

[`canvas.prototype.html`](./canvas.prototype.html) is a **throwaway** prototype (no build, no server, no
persistence — double-click to open) that settled the constrained-canvas interaction model for
[#255](https://github.com/howardyang2009/PATH/issues/255). It carries three switchable variants —
drill-down, inline-Scratch, and the chosen **hybrid** — over one sample workflow, and answers the
ticket's open questions (parallel join modes, where conditions live, mandatory while-do max-iterations,
inline checkpoints, spatial sequence order, depth-3+ readability, the add-node gesture). The spec above
folds in its validated decisions; the file stays the **primary source** behind them.

The **fully-iterated prototype is on `main`** — this in-tree file — merged through
[#305](https://github.com/howardyang2009/PATH/pull/305). Its development branch
[`proto/designer-canvas-255`](https://github.com/howardyang2009/PATH/tree/proto/designer-canvas-255)
stays as the primary-source history (and as the target of the spec's blob links); it is not deleted.
