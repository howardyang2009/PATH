# A hosted run executes in one VM per engine invocation

**Status:** accepted. Local mode is unchanged and runs in process.

## Context

On the hosted website, any signed-in user can author a workflow. A `binary` step runs a command
through `spawn`, and controllers and `prompt` steps run engine code with the user's secrets. On one
shared Mac mini, in-process execution would give every user the Server's file system, environment
and other users' data.

## Decision

1. **`SandboxedRuns` beside the in-process runs.** In hosted mode a `SandboxedRuns` implementation
   of `LiveRuns` (`packages/server/src/live-runs.ts`) executes runs. Local mode keeps the in-process
   implementation.
2. **One VM per engine invocation.** Start, Resume and Complete each get a fresh VM that runs the
   engine for the whole root run (controllers, `prompt`, `binary`) and exits when the engine exits,
   including at `awaiting`. Not one VM per `binary` step.
3. **Apple `container`** on the host, behind a thin `SandboxRuntime` seam. Docker or OrbStack stay
   the fallback behind the same seam.
4. **The host stays the record.** The host mounts the root run's blob directory read-write, the VM
   streams log events out live, and the VM exports its rows at exit. The host validates them: forces
   `root_run_id`, rejects run-id collisions, confines blob refs to the root's directory and caps
   sizes. Resume and Complete copy in the needed rows and mount the predecessor's blobs read-only.
5. **One store per user** at `users/<user-id>/.path/`. A run of a shared workflow is stored in the
   launcher's store.
6. **Limits** (config): 4 CPUs and 4 GB per VM, 1 h per invocation, at most 3 VMs overall and 1 per
   user; extra launches stay `pending`.

## Considered options

- **Sandbox only the `binary` step**: controllers and `prompt` would still run user-authored code
  paths and secrets in the Server process.
- **One long-lived VM per user**: idle VMs hold memory on a 24 GB host, and state leaks between runs.
- **`sandbox-exec`**: deprecated by Apple.

## Consequences

- Each invocation pays a VM start. `awaiting` runs hold no VM.
- One image (Node, engine build, plugin folders, `git`, `curl`, `python3`, `jq`) is rebuilt per
  PATH release; steps need their tools inside it.
- A lost VM marks `running` rows `failed` ("sandbox lost"); a reaper at Server start removes orphan
  VMs by label.
