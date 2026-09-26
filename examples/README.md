# Examples

Sample `*.workflow.json` files, kept as something to read and copy. They are not part of any package,
not run by CI, and their steps call the `claude` CLI, so running one needs that CLI on `PATH`.

| File | What it shows |
| --- | --- |
| [`w1.workflow.json`](w1.workflow.json) | A release-notes run for this repo: gather a commit range, summarize in parallel, draft, have a checkpoint judge the draft, then revise in a `while-do` loop until the verdict passes. Its loop body is a **nested workflow** — `ref: "w2.workflow.json"` — which is why the two files sit together. |
| [`w2.workflow.json`](w2.workflow.json) | The nested child of `w1`: revise the draft, judge it, then a checkpoint that reports whether it is well formed. |
| [`jira-workflow.workflow.json`](jira-workflow.workflow.json) | A Jira-shaped flow whose steps are all `person-activity`, for trying human-in-the-loop steps and `goto` round trips without a real integration. |

Run one against a project:

```bash
pnpm path run examples/w1.workflow.json
```

The workflows the repo itself uses — acceptance probes and the release-notes dogfood — live in
[`docs/acceptance-workflow/`](../docs/acceptance-workflow) and [`docs/dogfood/`](../docs/dogfood).
