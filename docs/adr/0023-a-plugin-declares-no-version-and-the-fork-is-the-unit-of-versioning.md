# A step plugin declares no version and no engine-compat; the fork is the unit of versioning

**Status:** accepted; the plugin-lifecycle decision of map
[#308](https://github.com/howardyang2009/PATH/issues/308), resolving
[#324](https://github.com/howardyang2009/PATH/issues/324). Builds on
[ADR 0019](0019-step-plugins-are-folders-under-packages-engine-step-plugins.md) (a step plugin is a
convention-only folder; sub-decision 1 reserved the *shape* of a version — "a key in the entry module's
own export, not a second file" — for whenever the lifecycle work wanted one; sub-decision 9 fixed
distribution as **clone-or-fork**), the [#315](https://github.com/howardyang2009/PATH/issues/315)
resolution (a workflow file declares no `requires` block; its `type` values *are* its dependency list;
**a plugin version is observable, never requirable**), [ADR 0018](0018-open-node-union-via-pure-registry-factory.md)
sub-decision 5 (a workflow naming a type the registry does not hold fails to load with a legible,
type-naming error), the [#313](https://github.com/howardyang2009/PATH/issues/313) resolution (a registry
entry is `{fields, workers, defaultWorker}`), and [ADR 0022](0022-config-vs-field-vs-input-line-for-a-step-type.md)
(the entry gained a second fragment, so its shape today is `{fields, config, workers, defaultWorker}`).
Informed by `FORMAT_VERSION`/`SUPERSEDED_FORMAT_VERSIONS`, the house precedent for versioning a
serialized thing (`packages/schema/src/workflow-file-type.ts:6`, `:17-21`).

The map's #315/#324 coupling was circular: neither strictly blocks the other, but #315 could not decide
whether a reference carries a version pin without knowing whether versions exist, and #324 could not
justify a version without knowing whether anything resolves against it. #315 grilled first and handed
this ticket its constraint (its comment on this issue, and ADR 0019's Consequences): a version is
**observable, never requirable** — no file, config value, or operator input may pin or range over one.
That closes "should files pin versions." It leaves the harder question this ADR answers: **what is a
version *for*, if nothing can demand one — and does a plugin declare one at all?**

**Amends** nothing. It is a clean non-amendment: a version that does not exist reaches no layer. The
registry entry keeps the `{fields, config, workers, defaultWorker}` shape #313 and ADR 0022 gave it
(sub-decision 6), and `@path/schema` still receives it as pure data. It corrects the CONTEXT.md
**Step-type plugin** entry, whose "it can pin no plugin version" clause (#315) is sharpened to record
that a plugin **declares** no version either.

Decision: **a step plugin declares no version and no engine-compat range. The reserved export key from
ADR 0019 sub-decision 1 stays reserved and unused. The unit of versioning is the fork — a plugin
folder's identity and history are a git commit in the reader's own PATH tree — so exactly one version of
a type is ever present, two versions of one type are refused by the `^[a-z][a-z0-9-]*$` folder rule, and
a removed or renamed type surfaces as ADR 0018 sub-decision 5's load-time error with no per-plugin
migration machinery. The item graduates by an explicit "no," not by omission.**

## Why a version has nothing to do

#315 fixed that nothing may *require* a version. The three purposes a version could still serve without
being required were named on this issue as the ones "worth grilling." Each fails against a fact already
in the code:

- **Run provenance** — a root run recording which plugin versions produced it. Under clone-or-fork
  (ADR 0019 sub-decision 9) a plugin folder's identity and history already *are* a commit in the reader's
  own tree; `git log -- packages/engine/step-plugins/<name>/` answers "which version ran" exactly, and a
  run knows its own `HEAD`. A declared version duplicating that is decoration. #315 declined provenance
  as *portability* machinery, not as audit — but audit is precisely where git already answers, so there
  is nothing left for a declared version to add.
- **A compat assertion the plugin makes about the engine.** There is no engine version to assert
  against: every workspace package is `"version": "0.0.0"` and `"private": true` (`packages/*/package.json`).
  And clone-or-fork ships the plugin and the engine as one commit in one tree, so they cannot drift — a
  compat range guards against a plugin meeting an engine it was not written for, a state this distribution
  model makes unreachable. The range has nothing to range over *and* nothing to protect.
- **A diagnostic string that only ever reaches an error message.** The step's `type` — the folder name,
  ADR 0019 sub-decision 2 — already identifies the plugin in every load and run error (ADR 0018
  sub-decision 5). A version appended to it compares against nothing and adds no fact an operator can act
  on, because they cannot pin it.

So the burden this issue placed on the version — "a declared version that nobody resolves against
anything is decoration; the burden is on the version to justify itself" — is not met. The honest close
is that a plugin declares none.

## The six pinned sub-decisions

### The version

1. **A step plugin declares no version.** The `stepPlugin` export stays `{fields, config, workers,
   defaultWorker}` (ADR 0022's four keys) with no `version` key added. This closes the #308-parked
   lifecycle item as a decision with its reasoning (above), which the item required either way: #308
   parked it, so silence would leave it parked. The one-folder-one-name rule (ADR 0019 sub-decisions 7
   and 9) already guarantees that exactly one version of a type is present at any time, so even a declared
   version could only ever record "the version that is here" — a constant relative to the tree, which git
   already names.

2. **ADR 0019 sub-decision 1's reserved shape stays reserved and unused.** That sub-decision fixed *where*
   a version would live "when the lifecycle work wants them" — a key in the export, never a second file —
   without committing that lifecycle would want one. Lifecycle looked and declined. The reservation is not
   deleted: it remains the correct home for a version **if** PATH ever stops being clone-or-fork. Should
   ADR 0019 sub-decision 9 be revisited — "if PATH is ever published as a package, this must be
   revisited" — a published `@path/engine` could meet third-party plugins across a real dependency edge,
   and *then* a version would resolve against something. It would still be observable-never-requirable per
   #315; this ADR does not pre-decide its form, only that today there is nothing for it to do.

### Engine-compat

3. **Engine-compat is out of scope while distribution is clone-or-fork — structurally, not by deferral.**
   Fact 2 above (no engine version) and the one-tree-one-commit property together mean an engine-compat
   range is not "not yet built"; it is empty of meaning. Recording it as *deferred* would imply a value
   waiting to be filled; it is not. It reopens exactly when ADR 0019 sub-decision 9's "if published"
   condition fires, and not before, so it is bounded to the same trigger as sub-decision 2.

### Two versions of one type

4. **Two versions of one type are refused; the fork is the unit of versioning.** This ratifies as the
   lifecycle decision what #315 already made true on disk. ADR 0019 sub-decision 13 constrains a folder
   name to `^[a-z][a-z0-9-]*$`, so `api-call@2` is not a legal folder name and two sibling folders cannot
   both be `api-call`. `api-call-v2` is a *different type* — its own folder, its own name, peer to
   `api-call`, not a second version of it — and is allowed precisely because it is not a versioning
   mechanism. A workflow selects between them the only way it selects any type: by naming one in a step's
   `type`. There is no registry support for side-by-side versions of one name, and #315 already declined
   the `requires` block that would be needed to ask for one. The unit at which a plugin is versioned is
   the fork: to change a plugin is to commit to your tree, and to adopt someone's change is to merge it
   (ADR 0019 sub-decision 9).

### Deprecation and removal

5. **A removed or renamed type surfaces as ADR 0018 sub-decision 5's load error; there is no per-plugin
   migration machinery.** A later PATH release, or the operator's own edit, drops or renames a plugin
   folder. Existing workflow files that name the vanished type then fail to load with the
   registry-relative, type-naming error ADR 0018 sub-decision 5 already defines — the same stance as an
   unset `$env` (CONTEXT.md, Step-plugin registry). That is the whole story, and a removed built-in earns
   no more. It is worth being explicit about why, because a format bump *does* earn a migration:
   `SUPERSEDED_FORMAT_VERSIONS` maps each old `path/workflow@N` token to a codemod chain
   (`packages/schema/src/workflow-file-type.ts:17-21`) because the *file's shape changed under the
   operator without the operator touching it*, so PATH owns lifting it. A vanished type is not that: the
   file is unchanged and still well-formed; a *type it references* left the reader's own tree, by the
   reader's own merge. PATH does not own the history of the operator's fork, so the remedy is git —
   restore the folder or edit the files — surfaced as a merge and then a load error, both visible and
   fixable, matching ADR 0019 sub-decision 9's recorded honesty about merge conflicts. An upstream rename
   of a built-in (say `binary`→`shell`) is an ordinary breaking source change that ships migration notes
   like any other, not a runtime migration registry keyed by type name.

### The registry

6. **The registry entry shape is unchanged; nothing reaches `@path/schema`.** Because no version is
   declared (sub-decision 1), none of this amends the entry #313 pinned as `{fields, workers,
   defaultWorker}` and ADR 0022 extended to `{fields, config, workers, defaultWorker}`. In particular
   nothing new crosses into the schema layer, which ADR 0018 sub-decision 3 keeps a pure function of
   `fields` and the worker names. Had a version become something the schema had to see, this ticket would
   have had to amend both #313 and ADR 0018 and say so; it does not, and the clean non-amendment is itself
   the recorded outcome.

## Considered options

- **Declare an optional, observable version token** (sub-decision 1), à la `path/workflow@2` — an opaque
  string in the export that only reaches provenance and error text. Rejected: all three purposes it could
  serve are already served or empty (see "Why a version has nothing to do"). An optional field that every
  honest use leaves unset, and that resolves against nothing when set, is the decoration fact 4 of the
  issue warned against.
- **Import semver for the plugin version** (sub-decision 1). Rejected twice over: the house precedent for
  versioning a serialized thing is an opaque token plus an explicit migration list
  (`SUPERSEDED_FORMAT_VERSIONS`), not semver, and semver's whole value is *ordering for resolution* —
  worthless when #315 forbids anything resolving against the version at all.
- **Give the engine a real version so engine-compat can range over it** (sub-decision 3). Rejected as
  out of scope for this ticket: versioning `@path/engine` is a distribution decision with its own
  consequences (ADR 0019 sub-decision 9's "if published" gate), and until it is published the plugin and
  engine are one commit that cannot drift, so the range would guard nothing.
- **Support side-by-side versions of one type** (sub-decision 4) by loosening the folder-name pattern or
  by encoding a version in the name. Rejected: loosening `^[a-z][a-z0-9-]*$` to admit `api-call@2`
  reopens the discovery-collision class ADR 0019 sub-decision 7 was chosen to dissolve, and it would need
  the `requires` block #315 already declined so a workflow could say which it wants. Encoding the version
  in the name (`api-call-v2`) is already available and is simply a different type — no new mechanism, no
  contradiction.
- **A per-plugin migration registry for removed/renamed types** (sub-decision 5), mirroring
  `SUPERSEDED_FORMAT_VERSIONS`. Rejected: a format bump migrates a file whose shape changed under the
  operator; a vanished type is the operator's own merge of their own fork, which PATH does not own the
  history of. The load-time "type not found" error is the correct and complete surface.

## Consequences

- **Map #308's lifecycle item closes by an explicit "no."** A plugin's self-description gains nothing: no
  `version`, no `engineCompat`. `defineStepPlugin` / `@path/engine/plugin` keeps the ADR 0022 signature
  `{fields, config, workers, defaultWorker}`. The item is graduated, not parked, which #308 required.
- **The fork is stated as the unit of versioning.** "One folder, one name, one version" (#315) is now
  backed by a reason for the version count being one: there is no version *field*, only the git identity
  of the folder, and a tree holds one folder per name. Provenance questions are git questions.
- **The reserved shape and engine-compat share one reopen trigger.** Both sub-decisions 2 and 3 reopen if
  and only if ADR 0019 sub-decision 9's "if PATH is ever published as a package" condition fires, at which
  point a version would resolve against a real dependency edge and could earn its keep — still observable,
  never requirable, per #315. Until then they are closed, not deferred.
- **No amendment ripples out.** The registry entry, ADR 0018's pure-schema boundary, ADR 0022's two
  fragments, and #313's seam are all untouched. CONTEXT.md's **Step-type plugin** clause is sharpened from
  "cannot pin a version" to "declares none"; the glossary keeps the rule, this ADR keeps the reasoning.
- **Map #308 has landed one ADR per decision** — 0018, 0019, 0020, 0021, 0022, and this 0023 — plus the
  #315 file-portability resolution. With #324 closed, the map's decision tickets are all resolved.
