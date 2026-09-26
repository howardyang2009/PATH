# Designer Canvas Library Survey — React Flow and Alternatives

**Issue:** [#262](https://github.com/howardyang2009/PATH/issues/262) — a canvas/graph library survey for PATH's Designer. Part of map [#254](https://github.com/howardyang2009/PATH/issues/254).
**Date:** 2026-08-21. Primary sources only (official docs, source code, actual LICENSE files, npm registry metadata). Each claim carries its source URL.

---

## The shape we are actually building

Locked decision 6: Designer blocks render as **containers** that nodes drop into, nesting arbitrarily,
and the author can **never** draw an edge the block grammar rejects. This is not the free
node-and-edge DAG editor that graph libraries target. The body of a workflow is a **tree** (a node has
one parent container), not a general graph. So the library evaluation is not "which graph editor is
nicest" but "which model best expresses *nested containers + grammar-constrained connections + a tree
body that lays itself out*, as a pure render of the workflow JSON."

That reframing does most of the work. The two hardest requirements, arbitrary container nesting and
*undrawable* invalid edges, are exactly where a general graph editor is weakest and where a hand-rolled
DOM tree is strongest.

---

## TL;DR & Recommendation

**Hand-roll the container/tree body with nested DOM (flexbox) plus a small drag-and-drop layer. Do not
adopt a node-and-edge graph library as the Designer's core.** If a later stage needs free-floating
canvas regions with drawn edges (for example, a data-flow overlay), reach for **React Flow
(`@xyflow/react`, MIT)** for *that* surface only. It is the strongest of the graph libs on every axis
that matters here (controlled state, connection validation, MIT licence, accessibility), but it still
models the world as nodes-and-edges-on-a-pane, which fights the container-tree shape rather than
expresses it.

Reasoning keyed to the constrained-container shape:

| PATH need | Verdict |
|---|---|
| Arbitrary container **nesting** | Nested DOM does this natively (a container *is* a `<div>` that holds children). Every graph lib bolts nesting onto an XY-plane model where a "parent" is a background rectangle and children carry parent-relative coordinates — workable but not what the model is *for*. |
| **Undrawable** invalid edges | In a container editor there is no free edge to draw: a node is *dropped into* a slot, and the grammar decides whether the drop target accepts it. Graph libs can only *reject a drop after the drag* (`isValidConnection`), never forbid the gesture. Drop-zone acceptance is a stronger guarantee and is trivial in the DOM. |
| **Auto-layout** of a tree body | The body is a tree, so layout is just normal block/flex flow — the browser lays it out for free. No graph lib ships layout at all; they all delegate to dagre/elk, which is overkill for a tree. |
| **Controlled state** / id stability | A hand-rolled render is by definition a pure function of the workflow JSON, so the node-identity guarantee is held by construction. React Flow can match this (fully controlled); most others own internal state. |
| Cost of a graph lib | For a tree-shaped, container-nesting editor, a graph library mostly *adds* an XY-coordinate model, edge routing, and a layout dependency you must then suppress — negative value until/unless free-floating edges appear. |

The rest of this document is the evidence behind that call, library by library.

---

## Candidate 1 — React Flow (`@xyflow/react`)

The library map #40 named in passing. Version surveyed: **12.11.3**.

**1. Nested containers / sub-flows.** First-class but coordinate-based. A child node is nested by a set
of `parentId`. Its position becomes relative to the parent's top-left, and `extent: 'parent'` clamps it
inside ([sub-flows guide](https://reactflow.dev/learn/layouting/sub-flows)). Parents must appear before
children in the nodes array. There is a convenience `group` node type "specifically for parent nodes
with no handles." The docs state **no maximum nesting depth**, but nesting is expressed as "a node that
happens to be a background rectangle for other nodes," not as true containment. You manage z-index,
relative coordinates, and drag-out behaviour yourself. Deep nesting works, but the interaction burden
(selection, drag across levels) grows with depth.

**2. Constrained connections.** `isValidConnection` is a **pre-creation** gate: "If you return `false`,
the edge will not be added to your flow" ([ReactFlow API](https://reactflow.dev/api-reference/react-flow),
[validation example](https://reactflow.dev/examples/interaction/validation)). During the drag, handles
receive status classes so you can style validity. The source code applies `connectingfrom` /
`connectingto` and a `valid` class to handles
([`packages/react/src/components/Handle/index.tsx`](https://github.com/xyflow/xyflow/blob/main/packages/react/src/components/Handle/index.tsx);
the "connectingfrom"/"connectingto" rename is recorded in the
[React changelog](https://github.com/xyflow/xyflow/blob/main/packages/react/CHANGELOG.md)). **The
guarantee is "invalid drop is rejected and can be shown invalid," not "invalid edge is undrawable."**
The user can still start and drag the connection gesture toward any handle; only the *commit* is
blocked. Known gap: `isValidConnection` does not fire between two handles of the same type, so those
classes are not applied there ([issue #2253](https://github.com/xyflow/xyflow/issues/2253)).

**3. Auto-layout.** None built in. The docs are explicit: "We have not implemented our own layouting
solution yet", and they recommend external engines: **dagre** ("largely a drop-in solution", recommended
for trees), **elkjs** (handles dynamic node sizes, sub-flow layouting, edge routing), and
**d3-hierarchy** (single-root trees, weak on variable node sizes)
([layouting guide](https://reactflow.dev/learn/layouting/layouting)).

**4. Licence and bundle.** **MIT**, confirmed from the actual repo LICENSE ("MIT License, Copyright (c)
2019-2025 webkid GmbH", [root LICENSE](https://github.com/xyflow/xyflow/blob/main/LICENSE)) and the
package's own `"license": "MIT"`
([npm registry metadata for 12.11.3](https://registry.npmjs.org/@xyflow/react/12.11.3)). React Flow Pro
is a **support/examples subscription** (Starter $169/mo up), and the vendor states "no features gated
behind a paid tier for using React Flow" commercially ([reactflow.dev/pro](https://reactflow.dev/pro)).
The free MIT library is fully usable in a commercial product. Bundle (bundlephobia API,
[@xyflow/react@12.11.3](https://bundlephobia.com/api/size?package=@xyflow/react@12.11.3)): **minified ≈
187 KB, min+gzip ≈ 58 KB, 3 dependencies** (`@xyflow/system`, `classcat`, `zustand`); npm unpacked size
≈ 1.2 MB. Layout adds dagre (~35 KB) or elkjs (~800 KB+) on top.

**5. Controlled state.** Fully supported. Pass `nodes` plus `edges` and handle `onNodesChange` /
`onEdgesChange`, and apply changes immutably with `applyNodeChanges` / `applyEdgeChanges`. The
alternative `defaultNodes` / `defaultEdges` is the uncontrolled path
([ReactFlow API](https://reactflow.dev/api-reference/react-flow)). In controlled mode the rendered graph
is a pure function of your arrays, and node ids are author-owned strings you supply, so the id-stability
guarantee from the node-identity ticket is straightforward to hold. (Internally React Flow uses a
zustand store, but in controlled mode your arrays are the source of truth.)

**6. Accessibility / keyboard.** The strongest of the graph libs. Built-in: Tab moves focus through
nodes/edges, Enter/Space selects, Escape clears, arrow keys move a selected node (Shift = faster), focus
auto-pans the node into view. Toggles `nodesFocusable`, `edgesFocusable`, `disableKeyboardA11y`. ARIA
roles and localisable `ariaLabelConfig`
([accessibility guide](https://reactflow.dev/learn/advanced-use/accessibility)).

**Fit:** best-in-class graph library, and the right pick *if PATH decides it needs a drawn-edge canvas*.
But its native model is nodes-on-a-pane. Containers are a coordinate trick, and invalid edges are only
reject-on-drop. It does not natively express "drop this node into that container slot."

---

## Candidate 2 — Reaflow (`reaflow`)

Reaviz's React node-diagram engine. Version surveyed: **5.4.1**.

- **Nesting:** advertised first-class. "Nesting of Nodes/Edges" is a headline feature
  ([README](https://github.com/reaviz/reaflow)).
- **Auto-layout:** built in, unlike React Flow. "Complex automatic layout leveraging ELKJS", so you do
  not hand-arrange boxes and do not wire up your own layout engine
  ([README](https://github.com/reaviz/reaflow)).
- **Constrained connections:** node-link checks are supported (proximity linking plus link-check
  helpers), but validation is drop-time, the same class of guarantee as React Flow.
- **Controlled state:** the `<Canvas nodes={} edges={} />` API is a controlled render of the arrays you
  pass ([README](https://github.com/reaviz/reaflow)).
- **Licence/bundle:** **Apache-2.0**
  ([npm registry metadata for 5.4.1](https://registry.npmjs.org/reaflow/latest)). It has a heavier
  dependency surface than React Flow. It pulls `elkjs`, `motion`, `reablocks`, `d3-shape`, several
  `kld-*` geometry packages and more ([same metadata]), because layout and animation ship inside it.
- **Accessibility:** no first-party keyboard/ARIA story comparable to React Flow's documented support.

**Fit:** the closest match to the container-tree shape among the graph libs (native nesting *and*
built-in ELK layout), and worth a real prototype if the team wants a library rather than a hand-roll. The
reservations are governance/maintenance surface (a much larger transitive dependency tree, a smaller
community than React Flow) and the same reject-on-drop connection model. Its ELK layout is also aimed at
graphs; a pure tree body still lays out more simply as DOM flow.

---

## Candidate 3 — JointJS (`@joint/core`)

Mature imperative (Backbone/SVG) diagramming toolkit. Core version surveyed: **4.3.1**.

- **Nesting/containers:** genuinely first-class and the best-modelled containment of any candidate.
  Elements carry `embeds` (child ids) and `parent`. "Whenever there is an interaction with a container,
  JointJS automatically modifies all of its embedded children." Auto-resize is built in:
  `element.fitToChildren({ deep: true })` and `element.fitParent({ deep: true })` grow containers around
  their contents. Nesting depth is unbounded (`getAncestors()` traverses arbitrarily)
  ([Containers & Grouping](https://docs.jointjs.com/learn/features/containers-and-grouping/)).
- **Constrained connections/embedding:** strong, and it covers *both* axes PATH cares about.
  `validateConnection()` gates links and `validateMagnet()` gates whether a port is even interactive.
  `validateEmbedding()` / `validateUnembedding()` gate which shapes may be dropped into which containers.
  This is the drop-zone-acceptance guarantee, not just edge-reject
  ([Containers & Grouping](https://docs.jointjs.com/learn/features/containers-and-grouping/),
  [Elements](https://docs.jointjs.com/learn/features/diagram-basics/elements/)).
- **Auto-layout:** `DirectedGraph` layout (wraps MIT **dagre**) ships in the free
  `@joint/layout-directed-graph` package
  ([Automatic layouts](https://docs.jointjs.com/learn/features/automatic-layouts/)). The dedicated
  **`TreeLayout`**, the one actually suited to a tree body, is part of commercial **JointJS+**
  ([JointJS+ TreeLayout](https://resources.jointjs.com/docs/rappid/v3.7/layout.TreeLayout.html)), not the
  free core.
- **Controlled state:** the `dia.Graph` model is the source of truth, but it is JointJS's own mutable
  Backbone model that you command imperatively (`graph.fromJSON` / `graph.toJSON`), **not** a React-style
  pure render of external JSON. To bridge it to a controlled React tree and hold id-stability means a
  manual diff/sync layer.
- **Licence:** the free core `@joint/core` is **MPL-2.0**
  ([npm registry metadata for 4.3.1](https://registry.npmjs.org/@joint/core/latest)), permissive enough
  (file-level copyleft) for a proprietary app, but the ergonomic pieces (TreeLayout, many UI tools) live
  in paid JointJS+.
- **Accessibility:** SVG-based; no documented first-class keyboard/screen-reader model.

**Fit:** the only library whose containment plus validation model actually *matches* the
constrained-container brief (embedding with `validateEmbedding` is exactly "which nodes may drop into
which container"). It loses on being imperative/Backbone rather than a controlled React render, on the
tree layout being paywalled, and on being a heavier framework to marry to a React app. If PATH ever
wanted to *buy* the container model instead of build it, JointJS is the one to prototype. But the
impedance mismatch with a controlled-React, JSON-as-truth architecture is real.

---

## Candidate 4 — Rete.js (`rete`)

Plugin-based node editor. Version surveyed: **2.0.6**.

- **Constrained connections:** genuinely pre-creation. A `connectioncreate` pipe returns nothing to
  block a connection before it is established, and sockets define compatibility with `isCompatibleWith()`.
  "prevents incompatible connections from being added to the graph in the first place, rather than
  removing them afterward" ([Validation guide](https://retejs.org/docs/guides/validation/)). This is the
  best connection-validation story of the graph libs, but it is still an *edge/socket* model.
- **Nesting/containers:** not a first-class concept. Rete is a node-and-socket dataflow editor. There is
  no container/embedding model equivalent to JointJS embeds or DOM nesting.
- **Controlled state:** the `NodeEditor` owns the graph. You drive it imperatively through plugins, not
  as a pure render of external JSON.
- **Auto-layout:** provided by a separate `rete-auto-arrange-plugin` (elk-based), not core.
- **Licence:** **MIT** ([npm registry metadata for 2.0.6](https://registry.npmjs.org/rete/latest)).

**Fit:** strong connection validation, wrong model. No containers, editor-owned state. Not a match for a
container-nesting tree editor.

---

## Candidate 5 — tldraw (`tldraw`)

Infinite-canvas whiteboard SDK. Version surveyed: **5.3.2**.

- **Licence — disqualifying for production without payment.** Not open source in the usual sense. The
  bundled `LICENSE.md` grants use only in "Development Environments" and requires "Not to use the
  Software in Production Environments", with runtime "License Key enforcement" (the watermark) you may
  not disable. Production use requires a commercial licence from tldraw, Inc.
  ([LICENSE.md](https://github.com/tldraw/tldraw/blob/main/LICENSE.md); npm records the licence as "SEE
  LICENSE IN LICENSE.md", [registry metadata](https://registry.npmjs.org/tldraw/latest)).
- **Model:** a freeform whiteboard (arbitrary shapes, freehand, arrows), not a grammar-constrained
  structured editor. To constrain it into "only valid nested containers" means to fight the product's
  whole premise.

**Fit:** wrong tool (freeform whiteboard) *and* a licence that bars production use unless paid. Rejected.

---

## Candidate 6 — Konva / react-konva (`react-konva`)

Low-level 2D canvas scene-graph. Version surveyed: **19.2.5**.

- **What it is:** declarative React bindings over the Konva canvas framework — shapes (`Rect`, `Circle`,
  `Line`, and so on), `Group`s and `Layer`s, drag support. Groups nest, "but no automatic layout or
  graph semantics are built in… a low-level, shape-based canvas rendering library without inherent
  support for graph theory concepts, automatic layout, or diagram semantics." A node editor is
  "something developers build *with* react-konva, not functionality the library provides"
  ([react-konva docs](https://konvajs.org/docs/react/index.html)).
- **Licence:** **MIT** ([npm registry metadata for 19.2.5](https://registry.npmjs.org/react-konva/latest)).

**Fit:** this is the hand-rolled baseline but *on a canvas instead of the DOM*. You build the model,
hit-testing, nesting rules, connection logic, and layout yourself, and you lose the DOM's free flex
layout, accessibility, and text handling. Only worth it at scales (thousands of nodes) where DOM
performance breaks down, not the Designer's regime. Rejected in favour of the DOM baseline.

---

## Candidate 7 — Hand-rolled baseline (nested DOM + drag-and-drop)

No graph library. Containers are nested `<div>`s laid out with flexbox. Nodes are children. Drag-and-drop
moves a node into a container's drop zone.

Measured against the seven questions, and honest about what a library would buy:

1. **Nesting:** native and unbounded — a container *is* a DOM node that contains its children. No
   parent-relative coordinate bookkeeping, no z-index juggling. This is the single biggest win over every
   XY-plane graph lib.
2. **Constrained connections, as drop-zone acceptance:** the strongest possible form of "undrawable
   invalid edge." There is no free edge to draw. A node is dropped into a container slot, and the drop
   zone consults the block grammar to accept or refuse *at drag-over time*. The invalid target simply
   does not light up and does not accept; the user cannot commit an invalid structure at all. Graph libs
   can only reject a *drawn edge* on drop; they cannot refuse the gesture.
3. **Auto-layout:** the browser *is* the layout engine. A tree body renders as ordinary nested block/flex
   flow — no dagre, no elk, no layout dependency — and it reflows automatically as the tree changes.
4. **Licence/bundle:** zero third-party licence surface; near-zero bundle beyond a small DnD helper.
5. **Controlled state / id stability:** trivially a pure render of the workflow JSON. The DOM is a
   function of the model, so node identity is whatever the JSON says. The id-stability guarantee is held
   by construction, with no library store to reconcile.
6. **Accessibility/keyboard:** you build it, but you build it on native focusable DOM elements, the
   substrate the graph libs are *emulating* on a canvas/SVG pane. React Flow's built-in a11y is the one
   thing a library hands you for free. A hand-rolled editor must implement Tab/arrow navigation itself,
   but it starts from real DOM semantics rather than faking them.
7. **What a library actually buys, honestly:** for a **tree-shaped, container-nesting** editor whose
   connections are containment (not free edges), a node-and-edge graph library buys **little and costs
   coordinate math plus a layout dependency plus a state store to reconcile**. Its value shows up only
   when you need *free-floating nodes with drawn, routed edges on an infinite pane*, which the
   constrained-container Designer explicitly is not. The library's edge-drawing, edge-routing, and
   XY-layout, its core value proposition, are all things this editor does not want.

**The cost of a hand-roll** is real and should not be waved away: pan/zoom of a large canvas, marquee
selection, drag performance with many nodes, keyboard a11y, and (if ever needed) to draw edges between
distant nodes are all work you inherit. The honest trade is: a hand-roll wins decisively for the
container-tree body; a library wins the day free-floating drawn edges enter the picture.

---

## Comparison

| Library | Licence (free tier) | Native container nesting | Invalid-connection guarantee | Auto-layout | Controlled render of external JSON | Built-in a11y/keyboard |
|---|---|---|---|---|---|---|
| **Hand-rolled DOM** | n/a | Native (DOM is the tree) | **Drop-zone refuses at drag-over** (strongest) | Browser flex/block flow | Pure by construction | Build it, on real DOM |
| React Flow 12.11.3 | MIT | Coordinate-based `parentId`+`extent` | Reject-on-drop (`isValidConnection`) | External (dagre/elk) | Yes (fully controlled) | Yes (documented) |
| Reaflow 5.4.1 | Apache-2.0 | First-class (headline feature) | Reject-on-drop | **Built-in ELK** | Yes (`nodes`/`edges` props) | Not documented |
| JointJS `@joint/core` 4.3.1 | MPL-2.0 | **First-class embeds + auto-resize + `validateEmbedding`** | **Pre-creation** (`validateConnection`/`validateMagnet`) | dagre free; TreeLayout paid (JointJS+) | Imperative `dia.Graph` model (needs sync layer) | Not documented |
| Rete.js 2.0.6 | MIT | Absent | **Pre-creation** (`connectioncreate`, `isCompatibleWith`) | Plugin (elk) | Editor-owned | Not documented |
| tldraw 5.3.2 | **Non-production without paid licence** | Freeform (not structured) | n/a (whiteboard) | n/a | Own store | Whiteboard-level |
| react-konva 19.2.5 | MIT | Canvas groups (no graph semantics) | Build it yourself | None | Build it yourself | None (canvas) |

---

## Recommendation

**Build the Designer's container/tree body hand-rolled: nested flexbox containers plus a drop-zone
drag-and-drop layer, rendered as a pure function of the workflow JSON. Do not take on a node-and-edge
graph library as the core.**

The single strongest reason: PATH's locked model is **containment, not connection**. Nodes drop into
container slots, and the grammar decides acceptance *at drag-over time*, which is the strongest possible
form of "invalid structure is undrawable." Every graph library inverts this. It models an XY-plane of
nodes joined by free edges, can only *reject an edge after it is drawn* (`isValidConnection` and
friends), turns nesting into parent-relative-coordinate bookkeeping, and ships no layout for the tree
body anyway. For a tree-shaped, container-nesting editor, those libraries subtract more than they add.

Two guardrails on that call:

- **If free-floating drawn edges become a requirement** (for example, an explicit data-flow overlay
  between non-adjacent nodes), adopt **React Flow (`@xyflow/react`, MIT)** for that surface only. It is
  the strongest graph lib here on controlled state, connection validation, licence, and accessibility.
  Keep it scoped to the edge-drawing surface, not the container tree.
- **If the team would rather buy the container model than build it**, the two worth a real prototype are
  **Reaflow** (native nesting plus built-in ELK, Apache-2.0, but a heavy dependency tree) and
  **JointJS `@joint/core`** (the only library whose `validateEmbedding` plus auto-resizing containers
  actually express the drop-a-node-into-a-container brief, but imperative/Backbone with the tree layout
  paywalled behind JointJS+). Both cost an impedance-matching layer against a controlled-React,
  JSON-as-truth architecture that the hand-rolled baseline gets for free.
