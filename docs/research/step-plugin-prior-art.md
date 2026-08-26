# Step plugins: prior art from five workflow engines

This resolves [#311](https://github.com/howardyang2009/PATH/issues/311), the prior-art half of
[map #308](https://github.com/howardyang2009/PATH/issues/308)'s frontier. #308 wants an ADR for
**step-type plugins**: a `./step-plugins/<name>/` folder that contributes a new leaf step *type* (its
config/payload fields) **bundled with an in-process TypeScript executor**, discovered and registered
before workflow validation, with no edit to `@path/schema`'s core union or the engine's leaf dispatch.
This file surveys how five comparable engines already solve that shape and extracts, per engine, what is
worth stealing and what is worth avoiding. It feeds the four decision tickets #308 names: the
**schema-open** child, the **executor-seam** ticket, the **folder-contract** ticket, and the
**portability/versioning** ticket. §7 maps each engine's pattern onto those four concerns; that mapping
is the point of the document, and a reader short on time should read §7 first.

**Date:** 2026-08-26. Primary sources only: official docs, published specs, and source files, each claim
carrying its URL (and file path plus interface name where it is code). **Verified against:** n8n
`master` (node loader API `n8nNodesApiVersion: 1`, interfaces at `packages/workflow/src/interfaces.ts`);
Temporal TypeScript SDK docs (docs.temporal.io, current); GitHub Actions docs (metadata syntax, runtimes
`node20`/`node24`); Argo Workflows `main` branch docs (Executor Plugins, `ExecutorPlugin`
`apiVersion: argoproj.io/v1alpha1`); Dagster docs (`@op`, `Config`, `Definitions`, current); Prefect v3
docs (`@task`). Docs move; versions are recorded where visible so a later reader can re-check drift.

Vocabulary is PATH's own (`CONTEXT.md`): a **step type** is what a node declares (`binary`, `prompt`);
the **executor seam** is the swappable in-process interface a worker implements (`LlmWorker.runPrompt`);
**folder contract** is the `./step-plugins/<name>/` discovery rule; **schema-open** is opening the closed
`z.discriminatedUnion` at `packages/schema/src/nodes.ts:129`; **portability** is what a workflow file
does when the type it names is absent or a different version.

---

## 1. n8n: the closest analogue

A n8n node is exactly the shape #308 targets: one module that exports a typed config schema plus a
bundled executor, discovered from a directory.

**Registry / discovery.** A node package declares its nodes in `package.json` under an `n8n` field, not
by a filesystem scan of arbitrary folders. The starter package shows the shape
([n8n-nodes-starter `package.json`](https://github.com/n8n-io/n8n-nodes-starter/blob/master/package.json)):

```json
"n8n": {
  "n8nNodesApiVersion": 1,
  "strict": true,
  "credentials": ["dist/credentials/GithubIssuesApi.credentials.js"],
  "nodes": ["dist/nodes/GithubIssues/GithubIssues.node.js", "dist/nodes/Example/Example.node.js"]
}
```

So discovery is a **manifest of compiled-JS entry paths**, resolved at boot. A community package is
additionally gated by naming (`n8n-nodes-*` or `@scope/n8n-nodes-*`) and the `n8n-community-node-package`
keyword ([n8n-nodes-starter README](https://github.com/n8n-io/n8n-nodes-starter)). The node's own `name`
field (below) is the runtime **type key**; the fully-qualified type a workflow references is
`<package>.<name>`, for example `n8n-nodes-base.mysql`.

**In-process module contract.** Each entry file exports a class implementing `INodeType`
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

The contract is a **data descriptor (`description`) beside a method (`execute`)**. This is the direct
mirror of PATH's plan: schema plus executor in one exported unit. The `this: IExecuteFunctions` typing is
how n8n injects the runtime context (parameter access, HTTP helpers) rather than passing it as an
argument.

**Config schema declaration + validation.** The schema is `INodeTypeDescription.properties`, a **typed
array**, not JSON Schema
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

Each entry (`interfaces.ts:2043`) is `INodeProperties`: `displayName`, `name`, `type`
(`NodePropertyTypes`), `default` (required), `options?`, `required?`, `displayOptions?` (conditional
visibility on other fields), `typeOptions?`, and `validateType?` (a `FieldType` used for
"validation and type casting"). The base fields (`name`, `displayName`, `group`, `description`,
`version` via `defaultVersion`) live in `INodeTypeBaseDescription` (`interfaces.ts:2687`). Two things to
note. First, this single array **doubles as the UI form and the validation contract**: it drives the
node editor and casts values. Second, validation is largely a **runtime cast** (`validateType`), not a
load-time schema check of the whole config object. So n8n gets rich per-field declaration but pays for
it with a schema shape welded to the UI.

**Portability / versioning when the plugin is absent.** A workflow node in n8n's JSON carries `type`
(the fully-qualified key) and `typeVersion`. Versioning is `IVersionedNodeType` (`interfaces.ts:2602`):

```ts
export interface IVersionedNodeType {
  nodeVersions: { [key: number]: INodeType };
  currentVersion: number;
  description: INodeTypeBaseDescription;
  getNodeType: (version?: number) => INodeType;
}
```

If the package is not installed, the type key does not resolve and the run fails hard with
`Unrecognized node type: <type>`; the workflow cannot even activate
([n8n #16348](https://github.com/n8n-io/n8n/issues/16348),
[n8n #15612](https://github.com/n8n-io/n8n/issues/15612)). A version drift after an upgrade produces the
same class of failure, comparing the saved `typeVersion` against what is installed
([n8n #19323](https://github.com/n8n-io/n8n/issues/19323)). n8n **fails fast and loud** on an absent or
mismatched type; there is no graceful-degradation path, and version pinning lives in the node instance's
`typeVersion`, not in the file's reference to the package.

---

## 2. Temporal: worker-side registration, dispatch by name

Temporal is the minimal end of the spectrum: no descriptor, no schema, just a named function registered
on a worker and called through a typed proxy.

**Registry / discovery.** Registration is **worker-side and explicit**. `Worker.create` takes an
`activities` object mapping string names to functions
([Activity basics, TS SDK](https://docs.temporal.io/develop/typescript/activities/basics)):

```ts
const worker = await Worker.create({
  workflowsPath: require.resolve('./workflows'),
  taskQueue: 'snippets',
  activities: { activityFoo: greet },
});
```

There is no directory scan and no marketplace: the "registry" is the object literal a worker author
passes at startup, keyed to a **task queue** that routes tasks to whichever worker polled it.

**In-process module contract.** "Activities are *just functions*"
([Activity basics](https://docs.temporal.io/develop/typescript/activities/basics)):
`export async function greet(name: string): Promise<string>`. There is no `description` object and no
interface to implement. A workflow calls an activity through `proxyActivities`, a type-safe proxy that
carries the function signatures but dispatches by **string name** over the task queue:

```ts
const { greet } = proxyActivities<typeof activities>({ startToCloseTimeout: '30 seconds' });
```

The type safety (`typeof activities`) is compile-time only; at runtime the name is the sole binding.

**Config schema declaration + validation.** There is **no config schema**. Activity arguments are plain
serialized values (JSON via the default data converter); their only "schema" is the TypeScript signature,
erased at runtime. What travels with the call is `ActivityOptions` (`startToCloseTimeout`, retry policy)
on `proxyActivities`, which is execution policy, not a config contract. Any input validation is code the
activity writes itself.

**Portability / versioning when the plugin is absent.** Dispatch by name means the absence check is a
**runtime task failure**, not a load error: if a worker has not registered the named activity, the task
fails with `Activity function actC is not registered on this Worker, available activities: ["actA","actB"]`
([Activity basics](https://docs.temporal.io/develop/typescript/activities/basics)). There is no
authoring-time validation that the name resolves, because the workflow and the worker are deployed
separately. Versioning of the *definition* is out of band (image/deploy versioning plus task-queue
routing); Temporal's in-language versioning APIs (`patched`/`getVersion`) address workflow-code changes,
not activity config schemas. For PATH this is the anti-pattern to note: name-only dispatch defers the
"type not found" failure to run time.

---

## 3. GitHub Actions: an external reference pinned in the workflow

GitHub Actions has no in-process plugin at all: the "type" is a reference to an external repository, and
everything about discovery and versioning lives in that reference.

**Registry / discovery.** A workflow step names an action with `uses:` and the runner resolves it by
fetching the referenced repo at the referenced ref
([metadata syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax)).
The forms are `owner/repo@ref`, a local `./path/to/action`, or `docker://image`. The Marketplace is
human-facing discovery, not a runtime registry. The action itself is defined by a metadata file named
`action.yml` (preferred) or `action.yaml` at the repo/dir root.

**In-process module contract.** The `runs:` block declares the entrypoint by convention rather than a
typed export. For JavaScript actions, `runs.using: node20` (or `node24`) plus `runs.main: index.js`, with
optional `runs.pre`/`runs.post` and `pre-if`/`post-if` guards. For containers, `runs.using: docker` plus
`runs.image`. For composites, `runs.using: composite` plus `runs.steps`
([metadata syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax)).
The "module contract" is therefore a repo with a metadata file and a named entry script, not an object
implementing an interface.

**Config schema declaration + validation.** Inputs are declared under `inputs:`, each with `description`
(string), `required` (boolean), `default` (string), an optional `type`, and `deprecationMessage`. Values
are passed at the call site with `with:` and surfaced to a JS/Docker action as `INPUT_<NAME>` environment
variables (uppercased, spaces to underscores) or to a composite action through the `inputs` context
([metadata syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax)).
Validation is weak: `required`/`default` are enforced, but there is no JSON-Schema-grade constraint on
values, and inputs are fundamentally strings. Outputs are declared too (composites require
`outputs.<id>.value`).

**Portability / versioning when the plugin is absent.** The `uses:` ref *is* the version pin, and it is
in the workflow file. A ref can be a tag (`@v4`), a branch, or a full commit SHA. GitHub's own guidance:
"Pinning an action to a full-length commit SHA is currently the only way to use an action as an immutable
release," because tags are mutable if a repo is compromised
([secure use reference](https://docs.github.com/en/actions/reference/secure-use-reference)). If the ref
does not resolve (action missing, ref invalid), the workflow fails at start. This is the cleanest
version-pinning model of the five: the reference carries owner, name, and an immutable version in one
string, checked before the job runs.

---

## 4. Argo Workflows: an out-of-process executor plugin

Argo's Executor Plugin is the shape PATH explicitly **ruled out** (locked decision 3: in-process only),
so it is most useful as a cautionary contrast that shows the cost of the out-of-process boundary.

**Registry / discovery.** A plugin is an `ExecutorPlugin` CustomResource installed into a Kubernetes
namespace, discovered at run time from the workflow's namespace plus the Argo install namespace, with the
workflow-namespace copy winning a name collision
([Executor Plugins](https://github.com/argoproj/argo-workflows/blob/main/docs/executor_plugins.md)).
Plugins are off by default; the controller must run with `ARGO_EXECUTOR_PLUGINS=true`. Discovery is thus
a **cluster registry (CRDs)**, not a folder.

**In-process module contract.** There is none: the plugin is **out of process**. The `ExecutorPlugin`
spec declares a `sidecar.container` (image, port) that the controller runs in a per-workflow **agent
pod**. The contract is HTTP: the sidecar implements `POST /api/v1/template.execute` and returns
`{"node": {"phase": "Succeeded", "message": "..."}}`, or `{"phase": "Running", "requeue": "2m"}` for
async work ([Executor Plugins](https://github.com/argoproj/argo-workflows/blob/main/docs/executor_plugins.md)).
A workflow template invokes it with `plugin: { hello: {} }`.

**Config schema declaration + validation.** None enforced by Argo. The `plugin: { <name>: { ... } }`
body is an arbitrary JSON blob passed through to the sidecar in the request's `template.plugin` field; the
plugin validates its own input. There is no declared config schema and no controller-side validation of
plugin parameters.

**Portability / versioning when the plugin is absent.** If the plugin is not installed, the workflow
**fails fatally when that template executes**
([Executor Plugins](https://github.com/argoproj/argo-workflows/blob/main/docs/executor_plugins.md)). This
is a run-time failure like Temporal's, not a load-time one, because plugin presence is a cluster-state
question, not a property of the workflow file. Versioning is by the sidecar container image tag in the
CR, entirely out of band from the workflow that references the plugin by bare name. The lesson for PATH:
an out-of-process boundary buys language independence but loses the typed config schema and the
authoring-time absence check, and it forces an async requeue protocol.

---

## 5. Dagster ops and Prefect tasks: decorator registries, typed config, no portable reference

Dagster and Prefect share a model: a decorated Python function with a typed config, registered by import
rather than by folder, with no serialized cross-reference to an external type.

**Registry / discovery (Dagster).** `@op` (or `@dg.op`) decorates a compute function and returns an
`OpDefinition` ([Ops](https://docs.dagster.io/guides/build/ops)). Ops are composed into jobs (`@job`
graphs) and surfaced through a top-level `Definitions` object, which "contains references to all the
definitions in a Dagster project"; a **code location** is a Python module holding a `Definitions`
instance, and `load_definitions_from_current_module()` auto-discovers module-scope objects
([Definitions](https://docs.dagster.io/api/dagster/definitions),
[code locations](https://dagster.io/blog/dagster-code-locations)). The registry is therefore an
**in-code object the tool imports**, not a directory scan. Prefect is even lighter: `@task` decorates a
function and there is **no central registry at all**; a task is registered by being called inside a
`@flow` ([write tasks](https://docs.prefect.io/v3/develop/write-tasks)).

**In-process module contract.** The contract is "a decorated function." Dagster: `@op def my_op(...)`.
Prefect: `@task def my_task(...)`. The executor and the declaration are the same object; there is no
separate descriptor.

**Config schema declaration + validation.** This is the pattern worth stealing. Dagster declares config
by annotating a `config` parameter with a subclass of `Config`, which "wraps `pydantic.BaseModel`"
([Ops](https://docs.dagster.io/guides/build/ops)):

```python
class MyOpConfig(dg.Config):
    api_endpoint: str

@dg.op
def my_configurable_op(config: MyOpConfig):
    ...
```

Pydantic gives **runtime validation and typing** of the config at run launch, checked against the
provided run config. Prefect validates call parameters via Pydantic type coercion on the function's type
hints ([write tasks](https://docs.prefect.io/v3/develop/write-tasks)); the `@task` decorator itself takes
execution policy (`name`, `retries`, `retry_delay_seconds`, `cache_key_fn`, `cache_policy`,
`timeout_seconds`, `tags`), not a config schema. Both engines get a real, validated, typed config schema
essentially for free by reusing the language's model library.

**Portability / versioning when the plugin is absent.** There is **no portable reference**. A Dagster job
or a Prefect flow is defined in Python code, not a serialized document that names an external type by
string. So "the plugin is absent" is not a workflow-file concern; it is an import error at code-location
load. There is no `typeVersion`-style pin because there is no cross-file reference to pin. For PATH, which
*does* have a portable JSON workflow format, this means Dagster/Prefect solve the schema and executor
dimensions beautifully but say nothing about the portability dimension, precisely because they never
serialize a reference to a type.

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

Framed against the four decision tickets #308 will spin out. The recurring split: the three code-native
engines (Temporal, Dagster, Prefect) have no serialized workflow document, so they never face PATH's
central tension, and n8n plus GitHub Actions, which *do* serialize a reference to a type, are the two that
actually inform PATH's design.

### 7.1 Schema-open (opening the closed `z.discriminatedUnion`)

**Steal from n8n.** n8n proves the target shape: a node's `type` is an **open string resolved against a
registry**, not a member of a closed compile-time union, and the type's config schema (`properties`)
travels *with* the type rather than living in one central file. That is exactly the move from
`nodes.ts:129`'s closed `z.discriminatedUnion` to a registry lookup. The discipline to keep: n8n still
validates strictly once the type resolves, and PATH's existing rule (unknown `type` rejected before any
step runs, per [api-door-pipeline-shape.md](api-door-pipeline-shape.md) §1) should survive the opening.
The union becomes "look the discriminator up in the registry, then validate the payload against the
schema that lookup returns."

**Avoid n8n's schema shape.** `INodeProperties` welds the config schema to the UI form and defers most
checking to a runtime cast (`validateType`). PATH has no UI to serve and already speaks zod/JSON-Schema,
so a plugin should declare a plain schema object (a zod schema per type) validated at **load time**, the
way the built-in union validates today, not a UI-shaped property array cast at run time.

**Ignore Temporal/Dagster/Prefect here.** They have no discriminated union to open because they have no
serialized type; the "registry" is a language symbol. The lesson is inverse: the discriminated union is
the price PATH pays for a portable JSON format, so the fix is to make the *discriminator* open
(validate-after-lookup), not to abandon serialization.

### 7.2 Executor seam (the in-process TypeScript executor)

**Steal the n8n and Dagster co-location.** n8n's `INodeType` bundles `description` (schema) and
`execute()` (executor) in one exported unit; Dagster's `@op` makes the decorated function both the
declaration and the executor. This is the strongest endorsement of #308's locked decision 2 (type bundled
with its executor). PATH's seam already exists as `LlmWorker.runPrompt`
([llm-worker.ts](https://github.com/howardyang2009/PATH/blob/main/packages/engine/src/llm/llm-worker.ts));
a plugin should export the same shape: one object exposing a schema and a `run(input, config, ctx)`
method, so the engine's leaf dispatch at
[run-workflow.ts:952](https://github.com/howardyang2009/PATH/blob/main/packages/engine/src/run-workflow.ts)
resolves the executor by type key instead of an `if/else`. Temporal's `this`-injected context vs. n8n's
`this: IExecuteFunctions` is a detail to decide (argument vs. bound `this`); prefer an explicit argument
for testability.

**Avoid Argo's out-of-process seam.** Argo is the control case for the boundary #308 ruled out. Its HTTP
sidecar contract (`POST /api/v1/template.execute`, `requeue`, agent pod) buys language independence and
loses the typed config schema, the authoring-time absence check, and simplicity. It confirms the locked
"in-process TS" decision was the right call: everything Argo pays for is a cost PATH gets to skip.

**Ignore GitHub Actions' entrypoint-by-convention.** `runs.main: index.js` is a loose, string-named
entrypoint suited to a multi-language runner. PATH wants a typed exported symbol (n8n/Dagster), not a
conventionally-named file.

### 7.3 Folder contract (`./step-plugins/<name>/`)

**Steal GitHub Actions' folder = metadata + code.** An action is a directory with a metadata file
(`action.yml`) at its root plus the entry code beside it, and the directory *is* the unit. That maps
cleanly onto `./step-plugins/<name>/` holding the schema declaration and the executor together. The
folder-name-as-type-name rule (#308 locked decision 2) matches n8n's node `name` acting as the type key,
and GitHub Actions' repo-name-in-`uses` acting as the reference.

**Prefer convention over n8n's manifest.** n8n discovers via an explicit `package.json` `n8n.nodes` array
of `dist/*.js` paths, which entails a build step and a hand-maintained path list. PATH can instead scan
`./step-plugins/*/` and load a conventional entry export (`index.ts`), so adding a type is dropping a
folder, with no manifest to edit and no core-union change, which is the #308 destination stated verbatim.

**Ignore the cluster/import registries.** Argo (k8s namespace CRDs) and Dagster/Prefect (Python import of
module-scope objects) are not folder contracts; they solve discovery in a runtime PATH does not share.
Only n8n and GitHub Actions offer a filesystem-folder model to mirror.

### 7.4 Portability / versioning (the reference to an absent or different type)

**Steal n8n's fail-fast and GitHub Actions' in-reference pin.** These two are the only engines whose
lessons apply, because only they serialize a type reference. n8n: an absent type is a **fatal, named,
load-time error** (`Unrecognized node type: <type>`) that blocks activation, matching PATH's existing
"unknown `type` rejected before any step runs" property, which the schema-open work must not regress.
GitHub Actions: the **version pin lives inside the reference** (`uses: repo@sha`), and a full commit SHA
is the immutable form. PATH should carry a type name plus an explicit version in the workflow's node, and
validate resolution before the run, so an absent or mismatched plugin is a clean load error, never a
mid-run surprise.

**Avoid n8n's silent version drift.** n8n's `typeVersion` lives on the node instance and mismatches
surface painfully only after an engine/package upgrade
([n8n #19323](https://github.com/n8n-io/n8n/issues/19323)). PATH should make the plugin's own version and
its engine-compat range explicit and validated at load, and settle the two-versions-of-one-type question
#308 parks under "Plugin lifecycle / versioning" rather than inherit n8n's drift.

**Avoid Temporal's and Argo's deferred failure.** Both defer "type not found" to run time because
presence is a deploy/cluster fact, not a file fact. PATH's plugins are author-trusted, co-located folders
loaded before validation, so PATH can and should check presence at load, keeping the failure early and
named.

**Note the limit of the code-native trio.** Dagster and Prefect offer nothing on portability because they
never serialize a reference; their strength (Pydantic-validated config bundled with the executor) is a
schema/executor lesson, already captured above. The portability dimension is answered only by n8n and
GitHub Actions.

### 7.5 One-line steal list

- **Registry:** open string type key resolved against a boot-time registry (n8n), scanned from
  `./step-plugins/*/` by convention (GitHub Actions folder model, not n8n's manifest).
- **Executor:** one exported unit holding schema + `run()`, resolved by key at leaf dispatch (n8n
  `INodeType`, Dagster `@op`).
- **Config schema:** a plain load-time-validated schema per type (zod), reusing the language's model
  library the way Dagster reuses Pydantic, not n8n's UI-welded property array.
- **Portability:** type name + explicit version in the node, resolution checked before the run, absent =
  fatal named load error (n8n's fail-fast + GitHub Actions' in-reference pin).

---

## 8. Claims not fully pinned to a primary source

- **n8n load-time vs. run-time of the "Unrecognized node type" error.** The interface and manifest shapes
  are from source (`interfaces.ts`, starter `package.json`). That the failure blocks *activation* and is
  fatal is drawn from maintainer/triage discussion on official n8n GitHub issues
  ([#16348](https://github.com/n8n-io/n8n/issues/16348),
  [#19323](https://github.com/n8n-io/n8n/issues/19323)), which are primary to the project but are issue
  threads, not reference docs. The exact load-vs-execute timing was not traced to the loader source in
  this pass; if that timing becomes load-bearing for the portability ticket, read the n8n node-loader
  source directly.
- **Dagster op config validation timing.** That `Config` wraps `pydantic.BaseModel` and validates is from
  the official Ops guide. The precise moment of validation ("at run launch against provided run config")
  is inferred from Pydantic's model semantics plus the guide, not quoted from a Dagster page stating the
  timing verbatim.
- **Prefect task parameter validation.** The official write-tasks page documents `@task` parameters but
  does not, in the fetched content, state task-level Pydantic coercion as explicitly as it does the
  flow-level `validate_parameters`. Task-parameter coercion is asserted from Prefect's general type-hint
  handling; treat the strength of task-level validation as "very likely" rather than "quoted."
- **n8n `n8nNodesApiVersion` semantics.** The value `1` is observed in the starter `package.json`; this
  file treats it as the node-loader API version. Its full compatibility contract was not read from the
  loader source.
