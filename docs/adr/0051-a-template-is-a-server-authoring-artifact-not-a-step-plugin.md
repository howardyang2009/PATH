# A template is a Server authoring artifact, not a step-plugin

**Status:** accepted; resolves the placement decision of Wayfinder map
[#558](https://github.com/howardyang2009/PATH/issues/558), ticket
[#565](https://github.com/howardyang2009/PATH/issues/565) ("CONTEXT.md terms + ADRs"). It is the
foundational template ADR the other three presuppose but none states:
[ADR 0048](0048-the-step-template-schema-is-an-envelope-over-a-validated-workflow-body.md) fixes the
template *schema*, [ADR 0049](0049-instantiation-is-a-detached-copy-that-re-stamps-ids-and-never-rewires.md)
fixes *instantiation*, [ADR 0050](0050-the-template-api-is-id-addressed-and-owns-the-template-write-door.md)
fixes the *API*. This one fixes where a template *lives in the architecture*. It leans on
[ADR 0019](0019-step-plugins-are-folders-under-packages-engine-step-plugins.md) (a step-plugin is a
folder the engine discovers and registers) and [ADR 0020](0020-plugin-masking-is-inherited-and-a-plugin-is-engine-trust.md)
(a plugin's worker is engine-trust code). The glossary terms are `CONTEXT.md` § Templates
(**Template**, **Template store**).

A **Step-Template** and a **Workflow-Template** are reusable authoring units: saved node fragments and
whole workflows an author drops into the Designer. The obvious way to add "a thing you insert into a
workflow" to a system that already has a plugin mechanism is to make it another plugin. We deliberately
did not.

## Decision

**A template is a Server-owned, engine-blind authoring artifact, distinct in kind from a step-plugin.**
The engine never registers a template, never validates against it, and never executes it. A template
expands into ordinary `path/workflow` nodes *before* any run (Instantiation, ADR 0049); the engine sees
only those nodes, indistinguishable from hand-authored ones. The Server owns template storage and the
template write door (the **Template store** and **Template API**, ADR 0050); the Designer reads and
instantiates from them.

## Considered options

**Template as a step-plugin** (rejected). A template would be a folder under the step-plugin root
(ADR 0019), contributing a `template`-shaped step type that the engine registers at load and expands at
run-time. Rejected because:

- It breaks engine-blindness. The engine would have to discover, register, and validate templates, so a
  template's correctness would become a run-time concern instead of an authoring-time one. Templates are
  an authoring convenience; nothing about executing a workflow should depend on them.
- It miscategorises trust. A step-plugin's worker is **engine-trust code** loaded in-process (ADR 0020);
  a template is inert authoring data with no worker and no `run` method. Making it a plugin would grant
  authoring content the trust level of engine source for no reason.
- It couples the wrong lifecycles. A plugin's unit of versioning is the fork (ADR 0023); a template is
  edited, saved, and deleted through a Server API at will (ADR 0050). Binding template editing to the
  plugin lifecycle would drag authoring churn into the engine's registry.

## Consequences

- The engine's step-plugin registry and workflow validation never see templates. A template can hold any
  registry-valid body without itself being an engine artifact.
- A template needs no plugin-style version: the fork-as-version rule (ADR 0023) does not apply. A
  template is identified by its GUID (ADR 0050) and edited in place.
- Templates and step-plugins live in separate trees: step-plugins under the engine
  (`packages/engine/...`, ADR 0019), templates under the Server (the **Template store**, ADR 0050). The
  two never share discovery, trust, or a write door.
