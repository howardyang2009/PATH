# Acceptance workflow: env-secret-probe

Resolves wayfinder ticket #117 — the reached-when of map #113 (`$env` secret sourcing). The
sibling of [NOTES.md](./NOTES.md)'s release-notes pipeline, and deliberately nothing like it: that
one is the MVP's definition of done, this one is a **seam test** for a single composed wrapper.

Driven by `packages/engine/test/acceptance/env-secret.test.ts` through the real `path run` — real
db, real blob tree, both log backends, no worker substituted (the probe is a `binary` step, so
unlike release-notes there is not even a scripted LLM in the way).

## Why synthetic

The release-notes pipeline uses **no secret at all** — its config is `commit_range`, `repo_path`,
`max_revisions`, `output_file` — and map #113 rules worker auth out of scope, so the LLM key is not
config either. Nothing existing exercises `$env`. A real token-authenticated third-party service
would need provisioning and an account, and belongs to the register's API-endpoint step type; so
this map brings its own proof, with **no network and no account**.

Existing examples stay as they are. Rewriting release-notes to source anything via `$env` is parked
in map #113's Not-yet-specified.

## The workflow

`env-secret-probe.workflow.json`, one `binary` step and one checkpoint:

```
config.token    = { "$secret": { "$env": "PATH_ACCEPTANCE_TOKEN" } }   sourced *and* masked
config.probe_id = { "$env": "PATH_ACCEPTANCE_PROBE_ID" }                sourced, not masked
```

1. `use-token` (binary, engine worker) — a `node -e` one-liner that takes the token **from argv**,
   writes it to `token-receipt.txt`, prints it to stderr in a rejected-credential line, echoes it on
   stdout, and exits with `config.exit_code`.
2. checkpoint `token-round-tripped` — `matches` on `context.echoed`.

Four shapes carry weight and none is incidental:

- **argv, never `process.env`.** The child inherits the whole process environment
  (`binary-worker.ts`), so a probe that read `$PATH_ACCEPTANCE_TOKEN` itself would pass with `$env`
  entirely unimplemented. Reaching argv means the wrapper resolved at run start, rode inheritance
  into the step's effective config, and `${config.token}` interpolated to the real credential.
- **`token-receipt.txt` sits outside `.path/`.** It is the evidence that the real value travelled,
  and it has to live somewhere the masking assertions are not looking — otherwise every "the
  artifact does not contain the token" assertion would pass just as well for a step that never ran.
- **`probe_id` is env-sourced but not secret.** Map #113 rejected "env is always secret" because
  masking is by value: an env-sourced model name would get its literal string scrubbed out of every
  log event in the run. The probe pins the distinction by carrying both kinds through the same step.
- **`exit_code` is an operator knob, not a second pipeline.** `--set exit_code=3` fails the step
  with the credential on its stderr, which is the only way to reach a run's **error string** — the
  one artifact class the happy path cannot produce.

The checkpoint's pattern (`^[A-Za-z0-9._-]+$`) is the one assertion the workflow file can make about
the value on its own: conditions cannot read `config` (deferred, mvp spec §10), so it cannot compare
against the token. It passes for a token and fails for a `{"$env": ...}` wrapper serialized in its
place, and its **trace** is what carries a secret into the log stream — ordinary lifecycle events
have their payloads stripped, so without a condition-bearing event there is no trace to mask.

## What it proves

| Claim | Asserted by |
| --- | --- |
| The child process receives the **real** value | `token-receipt.txt` equals the token |
| Input object blob is masked | `input.json` — `token` is `[secret:token]`, `probe_id` is literal |
| Output object blob is masked | `output.json` |
| `context.json` write-through is masked | root run's `context.json` |
| Captured stderr is masked | `stderr.txt` |
| Condition **traces** are masked | `checkpoint-passed` event's trace `value`, on **both** log backends |
| Failed-step **error strings** are masked | the `step-finished` event carrying `status: "failed"`, both backends, under `--set exit_code=3` |
| An env-sourced value **not** marked secret stays literal | `probe_id` in `stderr.txt` and in the run's printed output |
| Nothing else on the audit surface leaks | every file under `.path/`, `path.db` included, swept for the raw value |
| An unset variable refuses the run before step 1 | run fails, error names the variable and its config key; no receipt; one `failed` run row, and the message on both log backends |
| Two unset variables are named together | `2 environment variables are not set`, both named |
| The CLI's own stderr **is** masked | `run failed:` carries `[secret:token]`, never the token (#123 — see below) |

## A surface the spec named that does not exist — since corrected (#124)

Ticket #117 and mvp-spec §8.3 both listed **"run-row error strings"** among the artifacts masking
covers, and `secret-mask.ts`'s header repeated it. There is no such thing to mask: `runs`
(`persistence/db.ts`) carries `status` and no error column, and `finishRun` writes only `status` and
`finished_at`. A failed step's error is persisted in the **log stream** alone — the `step-finished`
event, which is what the probe asserts, on both backends. The masking that reaches the real surface
was always complete; the wording was stale, and #124 corrected §8.3 and the header to name the event.

One claim made here at the time was itself wrong, and is worth recording rather than quietly
deleting: the **unset-variable** failure is *not* persisted nowhere. The engine's `run-finished`
observation narrates as a failed `step-finished` (`logging-observer.ts`), so the message naming the
missing variables reaches both backends like any other run error — the probe now asserts exactly
that, alongside the `failed` run row. What is true is the narrower thing: a reader holding a run row
cannot say *why* the run failed without joining the log stream. Whether the row should answer that
itself is now in mvp-spec §10's deferred register, next to map #113's parked "how a missing-variable
failure surfaces in the server/SSE/viewer path".

## Automated, and how the variable is set

Automated, not a manual case — the default answer of ticket #117, and nothing about the setup makes
it fragile: the variable is set on `process.env` of the **test process** in `beforeEach` and restored
in `afterEach`, which is exactly the environment `runWorkflow` snapshots at run start. No CI secret,
no `.env` file, no shell plumbing.

The value is a synthetic constant in the test file, long and distinctive on purpose — masking is by
value, so a short or common one would over-replace and let "the artifact does not contain it" pass
for the wrong reason. It is never written into a workflow file, a `--config` file, or a `--set`
argument; `$env` is precisely what keeps it out of all three.

## The edge this file used to pin, since closed (#123)

`path run` printed `run failed: <error>` on **its own stderr, unmasked** — masking was a
*persistence*-boundary concern only, and the `RunResult` handed back to the caller was documented as
unmasked, so a credential on a failed step's stderr reached the operator's terminal and, in CI, the
build log. Ticket #117 pinned that as a boundary rather than endorsing it; #123 decided the terminal
*is* an audit surface (under `$env` the operator is often a secret store and the terminal often a
retained log) and masked `RunResult.error` at the run's return.

What did **not** change: the `output` of a **succeeded** run. It is the run's product, the CLI prints
it, and masking it would hand an operator `[secret:key]` where their pipeline's answer belongs. So a
workflow whose output map *is* a secret still prints the real value — deliberately. A failed or
cancelled run has no output contract, so what it returns is masked along with its error; that pair is
pinned in `run-workflow.test.ts`, where a file can be shaped for it.
