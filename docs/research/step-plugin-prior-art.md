# Step plugins: prior art from five workflow engines

This document resolves [#311](https://github.com/howardyang2009/PATH/issues/311). It is the prior-art
half of [map #308](https://github.com/howardyang2009/PATH/issues/308). #308 asks for an ADR for
**step-type plugins**. A step-type plugin is a `./step-plugins/<name>/` folder. The folder contributes a
new leaf step *type*, that is, the type's config and payload fields. The folder also bundles an
in-process TypeScript executor for that type. The engine discovers and registers the plugin before it
validates a workflow. The engine does this with no edit to the core union in `@path/schema` and no edit
to the engine's leaf dispatch.

This document surveys five comparable engines. Each engine already solves this shape. For each engine,
the survey gives what to steal and what to avoid. The survey feeds the four decision tickets that #308
names: the **schema-open** child, the **executor-seam** ticket, the **folder-contract** ticket, and the
**portability/versioning** ticket. §7 maps each engine's pattern onto these four concerns. That mapping
is the goal of this document. A reader who is short on time must read §7 first.

**Date:** 2026-08-26. This document uses primary sources only: official docs, published specs, and source
files. Each claim carries its URL. Where a claim is code, the claim also carries the file path and the
interface name. **Verified against:** n8n `master` (node loader API `n8nNodesApiVersion: 1`, interfaces
at `packages/workflow/src/interfaces.ts`); Temporal TypeScript SDK docs (docs.temporal.io, current);
GitHub Actions docs (metadata syntax, runtimes `node20`/`node24`); Argo Workflows `main` branch docs
(Executor Plugins, `ExecutorPlugin` `apiVersion: argoproj.io/v1alpha1`); Dagster docs (`@op`, `Config`,
`Definitions`, current); Prefect v3 docs (`@task`). Docs move. This document records versions where they
are visible, so that a later reader can check for drift.

The vocabulary is PATH's own (`CONTEXT.md`). A **step type** is what a node declares, for example
`binary` or `prompt`. The **executor seam** is the swappable in-process interface that a worker
implements, for example `LlmWorker.runPrompt`. The **folder contract** is the `./step-plugins/<name>/`
discovery rule. **Schema-open** is the work to open the closed `z.discriminatedUnion` at
`packages/schema/src/nodes.ts:129`. **Portability** is what a workflow file does when the type it names is
absent or is a different version.

---

## 1. n8n: the closest analogue

An n8n node has the exact shape that #308 targets. One module exports a typed config schema and a bundled
executor. The engine discovers the module from a directory.

**Registry / discovery.** A node package declares its nodes in `package.json`, under an `n8n` field. It
does not use a filesystem scan of arbitrary folders. The starter package shows the shape
([n8n-nodes-starter `package.json`](https://github.com/n8n-io/n8n-nodes-starter/blob/master/package.json)):

```json
"n8n": {
  "n8nNodesApiVersion": 1,
  "strict": true,
  "credentials": ["dist/credentials/GithubIssuesApi.credentials.js"],
  "nodes": ["dist/nodes/GithubIssues/GithubIssues.node.js", "dist/nodes/Example/Example.node.js"]
}
```

Discovery is a **manifest of compiled-JS entry paths**. The engine resolves the manifest at boot. A
community package must also pass a naming gate (`n8n-nodes-*` or `@scope/n8n-nodes-*`) and carry the
`n8n-community-node-package` keyword ([n8n-nodes-starter README](https://github.com/n8n-io/n8n-nodes-starter)).
The node's own `name` field (see below) is the runtime **type key**. The fully-qualified type that a
workflow references is `<package>.<name>`, for example `n8n-nodes-base.mysql`.

**In-process module contract.** Each entry file exports a class. The class implements `INodeType`
([`packages/workflow/src/interfaces.ts:2430`](https://github.com/n8n-io/n8n/blob/master/packages/workflow/src/interfaces.ts)):

```ts
export interface INodeType {
  description: INodeTypeDescription;
  execute?(this: IExecuteFunctions, response?: EngineResponse): Promise<NodeOutput>;
  poll?(this: IPollFunctions): Promise<INodeExecutionData[][] | null>;
  trigger?(this: ITriggerFunctions): Promise<ITriggerResponse | undefined>;
  webhook?(this: IWebhookFunctions): Promise<IWebhookResponseData>;
  methods?: { loadOptions?: {...}; listSearch?: {...}; credentialTest?: {...} };
}
```

The contract is a **data descriptor (`description`) next to a method (`execute`)**. This is the direct
mirror of PATH's plan: one exported unit holds the schema and the executor. The `this: IExecuteFunctions`
type is how n8n injects the runtime context (parameter access, HTTP helpers). n8n does not pass the
context as an argument.

**Config schema declaration + validation.** The schema is `INodeTypeDescription.properties`. It is a
**typed array**, not JSON Schema
([`interfaces.ts:2970`](https://github.com/n8n-io/n8n/blob/master/packages/workflow/src/interfaces.ts)):

```ts
export interface INodeTypeDescription extends INodeTypeBaseDescription {
  version: number | number[];
  inputs: Array<NodeConnectionType | INodeInputConfiguration> | ExpressionString;
  outputs: Array<NodeConnectionType | INodeOutputConfiguration> | ExpressionString;
  properties: INodeProperties[];
  credentials?: INodeCredentialDescription[];
  ...
}
```

Each entry (`interfaces.ts:2043`) is `INodeProperties`. It carries `displayName`, `name`, `type`
(`NodePropertyTypes`), `default` (required), `options?`, `required?`, `displayOptions?` (conditional
visibility on other fields), `typeOptions?`, and `validateType?` (a `FieldType` used for "validation and
type casting"). The base fields (`name`, `displayName`, `group`, `description`, and `version` via
`defaultVersion`) live in `INodeTypeBaseDescription` (`interfaces.ts:2687`). Note two things. First, this
single array **is both the UI form and the validation contract**. It drives the node editor and it casts
values. Second, validation is mostly a **runtime cast** (`validateType`). It is not a load-time schema
check of the whole config object. So n8n gets a rich per-field declaration. But it pays for the
declaration with a schema shape that is welded to the UI.

**Portability / versioning when the plugin is absent.** A workflow node in n8n's JSON carries `type` (the
fully-qualified key) and `typeVersion`. Versioning is `IVersionedNodeType` (`interfaces.ts:2602`):

```ts
export interface IVersionedNodeType {
  nodeVersions: { [key: number]: INodeType };
  currentVersion: number;
  description: INodeTypeBaseDescription;
  getNodeType: (version?: number) => INodeType;
}
```

If the package is not installed, the type key does not resolve. The run then fails hard with
`Unrecognized node type: <type>`, and the workflow cannot activate
([n8n #16348](https://github.com/n8n-io/n8n/issues/16348),
[n8n #15612](https://github.com/n8n-io/n8n/issues/15612)). A version drift after an upgrade produces the
same class of failure. n8n compares the saved `typeVersion` against the installed version
([n8n #19323](https://github.com/n8n-io/n8n/issues/19323)). So n8n **fails fast and loud** on an absent or
mismatched type. There is no graceful-degradation path. The version pin lives in the node instance's
`typeVersion`, not in the file's reference to the package.

---

## 2. Temporal: worker-side registration, dispatch by name

Temporal is the minimal end of the range. It has no descriptor and no schema. It has a named function,
registered on a worker, called through a typed proxy.

**Registry / discovery.** Registration is **worker-side and explicit**. `Worker.create` takes an
`activities` object. The object maps string names to functions
([Activity basics, TS SDK](https://docs.temporal.io/develop/typescript/activities/basics)):

```ts
const worker = await Worker.create({
  workflowsPath: require.resolve('./workflows'),
  taskQueue: 'snippets',
  activities: { activityFoo: greet },
});
```

There is no directory scan and no marketplace. The "registry" is the object literal that a worker author
passes at startup. The object is keyed to a **task queue**. The task queue routes tasks to the worker
that polled it.

**In-process module contract.** "Activities are *just functions*"
([Activity basics](https://docs.temporal.io/develop/typescript/activities/basics)):
`export async function greet(name: string): Promise<string>`. There is no `description` object and no
interface to implement. A workflow calls an activity through `proxyActivities`. This is a type-safe proxy.
It carries the function signatures. But it dispatches by **string name** over the task queue:

```ts
const { greet } = proxyActivities<typeof activities>({ startToCloseTimeout: '30 seconds' });
```

The type safety (`typeof activities`) is compile-time only. At runtime, the name is the only binding.

**Config schema declaration + validation.** There is **no config schema**. Activity arguments are plain
serialized values (JSON, via the default data converter). Their only "schema" is the TypeScript
signature, and the runtime erases the signature. What travels with the call is `ActivityOptions`
(`startToCloseTimeout`, retry policy) on `proxyActivities`. That is execution policy, not a config
contract. The activity writes any input validation itself.

**Portability / versioning when the plugin is absent.** Dispatch by name makes the absence check a
**runtime task failure**, not a load error. If a worker has not registered the named activity, the task
fails with `Activity function actC is not registered on this Worker, available activities: ["actA","actB"]`
([Activity basics](https://docs.temporal.io/develop/typescript/activities/basics)). There is no
authoring-time check that the name resolves, because Temporal deploys the workflow and the worker
separately. Versioning of the *definition* is out of band (image and deploy versioning, plus task-queue
routing). Temporal's in-language versioning APIs (`patched` and `getVersion`) address workflow-code
changes, not activity config schemas. For PATH, this is the anti-pattern to note: name-only dispatch
defers the "type not found" failure to run time.

---

## 3. GitHub Actions: an external reference pinned in the workflow

GitHub Actions has no in-process plugin. The "type" is a reference to an external repository. All of
discovery and versioning lives in that reference.

**Registry / discovery.** A workflow step names an action with `uses:`. The runner resolves the action.
It fetches the referenced repo at the referenced ref
([metadata syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax)).
The forms are `owner/repo@ref`, a local `./path/to/action`, or `docker://image`. The Marketplace is
human-facing discovery, not a runtime registry. A metadata file defines the action. The file is named
`action.yml` (preferred) or `action.yaml`, at the repo or directory root.

**In-process module contract.** The `runs:` block declares the entrypoint by convention, not by a typed
export. For JavaScript actions, `runs.using` is `node20` or `node24`, plus `runs.main: index.js`, with
optional `runs.pre` and `runs.post` and their `pre-if` and `post-if` guards. For containers, `runs.using`
is `docker`, plus `runs.image`. For composites, `runs.using` is `composite`, plus `runs.steps`
([metadata syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax)).
So the "module contract" is a repo with a metadata file and a named entry script. It is not an object that
implements an interface.

**Config schema declaration + validation.** The action declares inputs under `inputs:`. Each input has
`description` (string), `required` (boolean), `default` (string), an optional `type`, and
`deprecationMessage`. The call site passes values with `with:`. The runner gives the values to a
JavaScript or Docker action as `INPUT_<NAME>` environment variables (uppercased, spaces to underscores).
It gives the values to a composite action through the `inputs` context
([metadata syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax)).
Validation is weak. The runner enforces `required` and `default`. But there is no JSON-Schema-grade
constraint on values, and inputs are strings at their base. The action declares outputs too (composites
require `outputs.<id>.value`).

**Portability / versioning when the plugin is absent.** The `uses:` ref *is* the version pin, and it is in
the workflow file. A ref can be a tag (`@v4`), a branch, or a full commit SHA. GitHub's own guidance
states: "Pinning an action to a full-length commit SHA is currently the only way to use an action as an
immutable release." Tags are mutable if a repo is compromised
([secure use reference](https://docs.github.com/en/actions/reference/secure-use-reference)). If the ref
does not resolve (action missing, or ref invalid), the workflow fails at start. This is the cleanest
version-pinning model of the five. The reference carries owner, name, and an immutable version in one
string. The runner checks the reference before the job runs.

---

## 4. Argo Workflows: an out-of-process executor plugin

Argo's Executor Plugin is the shape that PATH **ruled out** (locked decision 3: in-process only). So it
is most useful as a warning example. It shows the cost of the out-of-process boundary.

**Registry / discovery.** A plugin is an `ExecutorPlugin` CustomResource, installed into a Kubernetes
namespace. The engine discovers it at run time, from the workflow's namespace plus the Argo install
namespace. On a name collision, the workflow-namespace copy wins
([Executor Plugins](https://github.com/argoproj/argo-workflows/blob/main/docs/executor_plugins.md)).
Plugins are off by default. The controller must run with `ARGO_EXECUTOR_PLUGINS=true`. So discovery is a
**cluster registry (CRDs)**, not a folder.

**In-process module contract.** There is none. The plugin is **out of process**. The `ExecutorPlugin`
spec declares a `sidecar.container` (image, port). The controller runs the container in a per-workflow
**agent pod**. The contract is HTTP. The sidecar implements `POST /api/v1/template.execute`. It returns
`{"node": {"phase": "Succeeded", "message": "..."}}`, or `{"phase": "Running", "requeue": "2m"}` for async
work ([Executor Plugins](https://github.com/argoproj/argo-workflows/blob/main/docs/executor_plugins.md)).
A workflow template invokes it with `plugin: { hello: {} }`.

**Config schema declaration + validation.** Argo enforces none. The `plugin: { <name>: { ... } }` body is
an arbitrary JSON blob. The controller passes it through to the sidecar, in the request's
`template.plugin` field. The plugin validates its own input. There is no declared config schema and no
controller-side validation of plugin parameters.

**Portability / versioning when the plugin is absent.** If the plugin is not installed, the workflow
**fails fatally when that template executes**
([Executor Plugins](https://github.com/argoproj/argo-workflows/blob/main/docs/executor_plugins.md)). This
is a run-time failure, like Temporal's, not a load-time one. The reason is that plugin presence is a
cluster-state question, not a property of the workflow file. Versioning is by the sidecar container image
tag in the CR. It is fully out of band from the workflow, which references the plugin by bare name. The
lesson for PATH: an out-of-process boundary buys language independence. But it loses the typed config
schema and the authoring-time absence check, and it forces an async requeue protocol.

---

## 5. Dagster ops and Prefect tasks: decorator registries, typed config, no portable reference

Dagster and Prefect share a model. Each uses a decorated Python function with a typed config. Each
registers the function by import, not by folder. Neither serializes a cross-reference to an external type.

**Registry / discovery (Dagster).** `@op` (or `@dg.op`) decorates a compute function and returns an
`OpDefinition` ([Ops](https://docs.dagster.io/guides/build/ops)). Ops compose into jobs (`@job` graphs).
A top-level `Definitions` object surfaces them. `Definitions` "contains references to all the definitions
in a Dagster project". A **code location** is a Python module that holds a `Definitions` instance.
`load_definitions_from_current_module()` auto-discovers module-scope objects
([Definitions](https://docs.dagster.io/api/dagster/definitions),
[code locations](https://dagster.io/blog/dagster-code-locations)). So the registry is an **in-code object
that the tool imports**, not a directory scan. Prefect is even lighter. `@task` decorates a function, and
there is **no central registry at all**. A task registers when code calls it inside a `@flow`
([write tasks](https://docs.prefect.io/v3/develop/write-tasks)).

**In-process module contract.** The contract is "a decorated function". Dagster: `@op def my_op(...)`.
Prefect: `@task def my_task(...)`. The executor and the declaration are the same object. There is no
separate descriptor.

**Config schema declaration + validation.** This is the pattern worth stealing. Dagster declares config
by annotating a `config` parameter with a subclass of `Config`. `Config` "wraps `pydantic.BaseModel`"
([Ops](https://docs.dagster.io/guides/build/ops)):

```python
class MyOpConfig(dg.Config):
    api_endpoint: str

@dg.op
def my_configurable_op(config: MyOpConfig):
    ...
```

Pydantic gives **runtime validation and typing** of the config at run launch. It checks the config against
the provided run config. Prefect validates call parameters through Pydantic type coercion on the
function's type hints ([write tasks](https://docs.prefect.io/v3/develop/write-tasks)). The `@task`
decorator itself takes execution policy (`name`, `retries`, `retry_delay_seconds`, `cache_key_fn`,
`cache_policy`, `timeout_seconds`, `tags`), not a config schema. Both engines get a real, validated, typed
config schema almost for free. They reuse the language's model library.

**Portability / versioning when the plugin is absent.** There is **no portable reference**. A Dagster job
or a Prefect flow is defined in Python code. It is not a serialized document that names an external type by
string. So "the plugin is absent" is not a workflow-file concern. It is an import error at code-location
load. There is no `typeVersion`-style pin, because there is no cross-file reference to pin. PATH *does*
have a portable JSON workflow format. So Dagster and Prefect solve the schema and executor dimensions well,
but they say nothing about the portability dimension. The reason is exact: they never serialize a reference
to a type.

---

## 6. Comparison

| | Registry / discovery | In-process module contract | Config schema + validation | Portability / versioning when absent |
|---|---|---|---|---|
| **n8n** | `package.json` `n8n.nodes` manifest of compiled-JS entry paths; type key `<pkg>.<name>` | class implementing `INodeType` = `description` object + `execute()` method | `INodeTypeDescription.properties: INodeProperties[]` (typed array, also drives UI); runtime cast via `validateType` | node carries `type` + `typeVersion`; absent = fatal `Unrecognized node type` at load, cannot activate; `IVersionedNodeType` |
| **Temporal** | worker-side `Worker.create({ activities })` object literal, keyed by task queue | activity is a plain function; called via `proxyActivities`, dispatched by string name | none; args are serialized values; TS signature erased at runtime; only `ActivityOptions` travel | run-time failure "activity not registered"; no load-time check; versioning out of band |
| **GitHub Actions** | `uses: owner/repo@ref` resolves an external repo; `action.yml` metadata file | `runs.using: node20/docker/composite` + `runs.main`/`image`/`steps` (entrypoint by convention) | `inputs:` map (`description`/`required`/`default`/`type`); passed via `with:`; weak, string-based | version pin is the `@ref` in the file; full-commit-SHA = immutable; unresolved ref fails at start |
| **Argo** | `ExecutorPlugin` CRD in a namespace; discovered from workflow + install namespace | out of process: sidecar HTTP server implementing `POST /api/v1/template.execute` | none enforced; `plugin: {name: {...}}` is a pass-through blob validated by the plugin | run-time fatal fail when template executes; version = image tag in CR, out of band |
| **Dagster / Prefect** | decorator (`@op`/`@task`); Dagster registers via `Definitions` code location; Prefect has no registry | decorated function; declaration and executor are one object | Dagster `Config(pydantic.BaseModel)` on a `config` param; Prefect Pydantic coercion on type hints; both validated at run launch | no portable reference; absence is an import error; no `typeVersion` pin |

---

## 7. What this means for PATH

This section frames each pattern against the four decision tickets that #308 will spin out. One split
recurs. Three engines are code-native (Temporal, Dagster, Prefect). They have no serialized workflow
document, so they never face PATH's central tension. Two engines serialize a reference to a type (n8n and
GitHub Actions). These two inform PATH's design.

### 7.1 Schema-open (opening the closed `z.discriminatedUnion`)

**Steal from n8n.** n8n proves the target shape. A node's `type` is an **open string, resolved against a
registry**. It is not a member of a closed compile-time union. The type's config schema (`properties`)
travels *with* the type, not in one central file. That is exactly the move from the closed
`z.discriminatedUnion` at `nodes.ts:129` to a registry lookup. Keep this discipline: n8n still validates
strictly once the type resolves. PATH's existing rule (an unknown `type` is rejected before any step runs,
per [api-door-pipeline-shape.md](api-door-pipeline-shape.md) §1) must survive the opening. The union
becomes this: look the discriminator up in the registry, then validate the payload against the schema that
the lookup returns.

**Avoid n8n's schema shape.** `INodeProperties` welds the config schema to the UI form. It defers most
checking to a runtime cast (`validateType`). PATH has no UI to serve, and it already speaks
zod/JSON-Schema. So a plugin must declare a plain schema object (one zod schema per type), validated at
**load time**, the way the built-in union validates today. A plugin must not declare a UI-shaped property
array cast at run time.

**Ignore Temporal, Dagster, and Prefect here.** They have no discriminated union to open, because they
have no serialized type. Their "registry" is a language symbol. The lesson is the inverse: the
discriminated union is the price PATH pays for a portable JSON format. So the fix is to make the
*discriminator* open (validate after lookup), not to abandon serialization.

### 7.2 Executor seam (the in-process TypeScript executor)

**Steal the n8n and Dagster co-location.** n8n's `INodeType` bundles `description` (schema) and `execute()`
(executor) in one exported unit. Dagster's `@op` makes the decorated function both the declaration and the
executor. This is the strongest support for #308's locked decision 2 (bundle the type with its executor).
PATH's seam already exists, as `LlmWorker.runPrompt`
([llm-worker.ts](https://github.com/howardyang2009/PATH/blob/main/packages/engine/src/llm/llm-worker.ts)).
A plugin must export the same shape: one object that exposes a schema and a `run(input, config, ctx)`
method. Then the engine's leaf dispatch at
[run-workflow.ts:952](https://github.com/howardyang2009/PATH/blob/main/packages/engine/src/run-workflow.ts)
resolves the executor by type key, not by an `if/else`. One detail stays open: Temporal's `this`-injected
context against n8n's `this: IExecuteFunctions` (argument, or bound `this`). Prefer an explicit argument,
for testability.

**Avoid Argo's out-of-process seam.** Argo is the control case for the boundary that #308 ruled out. Its
HTTP sidecar contract (`POST /api/v1/template.execute`, `requeue`, agent pod) buys language independence.
But it loses the typed config schema, the authoring-time absence check, and simplicity. It confirms that
the locked "in-process TS" decision was correct. Everything Argo pays for is a cost that PATH gets to skip.

**Ignore GitHub Actions' entrypoint-by-convention.** `runs.main: index.js` is a loose, string-named
entrypoint. It suits a multi-language runner. PATH wants a typed exported symbol (n8n or Dagster), not a
file that is named by convention.

### 7.3 Folder contract (`./step-plugins/<name>/`)

**Steal GitHub Actions' folder = metadata + code.** An action is a directory. It holds a metadata file
(`action.yml`) at its root, plus the entry code beside the file. The directory *is* the unit. That maps
cleanly onto `./step-plugins/<name>/`, which holds the schema declaration and the executor together. The
folder-name-as-type-name rule (#308 locked decision 2) matches n8n's node `name`, which acts as the type
key, and GitHub Actions' repo-name-in-`uses`, which acts as the reference.

**Prefer convention over n8n's manifest.** n8n discovers through an explicit `package.json` `n8n.nodes`
array of `dist/*.js` paths. That entails a build step and a hand-maintained path list. PATH can instead
scan `./step-plugins/*/` and load a conventional entry export (`index.ts`). Then adding a type is dropping
a folder, with no manifest to edit and no core-union change. That is the #308 destination, stated verbatim.

**Ignore the cluster and import registries.** Argo (k8s namespace CRDs) and Dagster/Prefect (Python import
of module-scope objects) are not folder contracts. They solve discovery in a runtime that PATH does not
share. Only n8n and GitHub Actions offer a filesystem-folder model to mirror.

### 7.4 Portability / versioning (the reference to an absent or different type)

**Steal n8n's fail-fast and GitHub Actions' in-reference pin.** Only these two engines have lessons that
apply, because only they serialize a type reference. n8n: an absent type is a **fatal, named, load-time
error** (`Unrecognized node type: <type>`) that blocks activation. This matches PATH's existing property
(an unknown `type` is rejected before any step runs), which the schema-open work must not regress. GitHub
Actions: the **version pin lives inside the reference** (`uses: repo@sha`), and a full commit SHA is the
immutable form. PATH must carry a type name plus an explicit version in the workflow's node. PATH must
validate the resolution before the run. Then an absent or mismatched plugin is a clean load error, never a
mid-run surprise.

**Avoid n8n's silent version drift.** n8n's `typeVersion` lives on the node instance. A mismatch surfaces
painfully, and only after an engine or package upgrade
([n8n #19323](https://github.com/n8n-io/n8n/issues/19323)). PATH must make the plugin's own version and its
engine-compat range explicit and validated at load. PATH must settle the "two versions of one type"
question that #308 parks under "Plugin lifecycle / versioning". PATH must not inherit n8n's drift.

**Avoid Temporal's and Argo's deferred failure.** Both defer "type not found" to run time, because presence
is a deploy or cluster fact, not a file fact. PATH's plugins are author-trusted, co-located folders, loaded
before validation. So PATH can and must check presence at load. This keeps the failure early and named.

**Note the limit of the code-native trio.** Dagster and Prefect offer nothing on portability, because they
never serialize a reference. Their strength (Pydantic-validated config, bundled with the executor) is a
schema/executor lesson, already captured above. Only n8n and GitHub Actions answer the portability
dimension.

### 7.5 One-line steal list

- **Registry:** an open string type key, resolved against a boot-time registry (n8n), and scanned from
  `./step-plugins/*/` by convention (the GitHub Actions folder model, not n8n's manifest).
- **Executor:** one exported unit that holds the schema plus `run()`, resolved by key at leaf dispatch (n8n
  `INodeType`, Dagster `@op`).
- **Config schema:** one plain load-time-validated schema per type (zod), which reuses the language's model
  library the way Dagster reuses Pydantic, not n8n's UI-welded property array.
- **Portability:** a type name plus an explicit version in the node, with resolution checked before the
  run. An absent type is a fatal, named load error (n8n's fail-fast plus GitHub Actions' in-reference pin).

---

## 8. Claims not fully pinned to a primary source

- **n8n load-time against run-time of the "Unrecognized node type" error.** The interface and manifest
  shapes come from source (`interfaces.ts`, starter `package.json`). The claim that the failure blocks
  *activation* and is fatal comes from maintainer and triage discussion on official n8n GitHub issues
  ([#16348](https://github.com/n8n-io/n8n/issues/16348),
  [#19323](https://github.com/n8n-io/n8n/issues/19323)). These are primary to the project, but they are
  issue threads, not reference docs. This pass did not trace the exact load-against-execute timing to the
  loader source. If that timing becomes load-bearing for the portability ticket, read the n8n node-loader
  source directly.
- **Dagster op config validation timing.** The claim that `Config` wraps `pydantic.BaseModel` and validates
  comes from the official Ops guide. The precise moment of validation ("at run launch, against the provided
  run config") is inferred from Pydantic's model semantics plus the guide. It is not quoted from a Dagster
  page that states the timing verbatim.
- **Prefect task parameter validation.** The official write-tasks page documents `@task` parameters. But in
  the fetched content, it does not state task-level Pydantic coercion as clearly as it states the
  flow-level `validate_parameters`. This document asserts task-parameter coercion from Prefect's general
  type-hint handling. Treat the strength of task-level validation as "very likely", not as "quoted".
- **n8n `n8nNodesApiVersion` semantics.** The value `1` is visible in the starter `package.json`. This
  document treats the value as the node-loader API version. This pass did not read the full compatibility
  contract from the loader source.
