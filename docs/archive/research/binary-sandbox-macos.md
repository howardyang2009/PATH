# Sandboxing the `binary` step on a macOS host

**Issue:** [#704](https://github.com/howardyang2009/PATH/issues/704), part of map [#711](https://github.com/howardyang2009/PATH/issues/711) (PATH website, multi-user).
**Date:** 2026-10-03. Primary sources only: Apple, Docker, OrbStack and Lima vendor docs, and the PATH source. Each claim names its source. Nothing here was measured on hardware; start-up figures are vendor claims or absent, and the "To verify" section lists what a build session must test.

## Question

The `binary` step type spawns arbitrary programs. V1 hosts PATH on a macOS Mac mini. Options to run each binary step in a sandbox: Docker Desktop, OrbStack, Apple `container`, `sandbox-exec`, a Linux VM. For each: isolation strength, per-run start-up cost, resource and network limits, how working files get mounted in and out, how the in-process worker calls it, licensing and cost.

## How the worker spawns programs today

Source: `packages/engine/plugin/step-plugin/binary/index.ts`. The old `packages/engine/src/binary-worker.ts` no longer exists; that file's header comment says the plugin folder is the only `binary` implementation since the cutover (#337).

- One `spawn(command, args, { cwd: resolvedCwd })` per step-run. No `env` option, so the child inherits the full engine process environment (including any provider keys or Clerk secrets in the Server process). This matters for per-user Secrets in the map.
- `cwd` resolves against the workflow file's directory (`request.cwd`), not `process.cwd()`.
- Step `input` is written to stdin (string, or `JSON.stringify` of the value), then stdin is closed. stdout and stderr are buffered in memory; no size cap.
- Abort: on `request.signal` abort the worker sends `SIGTERM` to the child. The engine derives `cancelled` from the signal.
- Result mapping: exit code 0 is `succeeded` with `output = stdout`; non-zero is `failed` with the last 500 characters of stderr in the message; a spawn error is `failed to start "<command>"`.
- No timeout, no CPU or memory limit, no network limit.
- The worker is registered as `workers: { spawn: ... }` with `defaultWorker: "spawn"`. A step type can declare several named workers and a node's `worker` field selects one (`docs/format/workflow-format.md`, around line 222). So a sandboxed worker can be a second named worker (for example `sandbox`) beside `spawn` without changing the node schema, or it can replace `spawn` as the default in hosted mode.

Consequence for every option below: the worker must turn `{command, args, cwd, input}` into "run this in an isolated environment, stream stdin in, collect stdout, stderr and exit code, kill on abort". All container and VM options expose that as a CLI the worker can `spawn` itself (the sandbox CLI becomes the child), so the worker body barely changes.

## Summary table

| Option | Isolation | Start-up per run | Limits | Host files in/out | Worker integration | Cost |
|---|---|---|---|---|---|---|
| Docker Desktop | Shared Linux VM, container namespaces inside it | Not documented by Docker; to measure | CPU, memory, pids, network `none`, read-only root, caps | Bind mount `-v` / `--mount`, VirtioFS on Apple virtualization | `spawn("docker", ["run", "--rm", ...])` | Free under 250 employees and $10M revenue; paid above |
| OrbStack | One shared Linux VM, container namespaces; machines have deep host integration | Vendor claim: app starts in 2 s; per-container figure not documented | Docker CLI flags (same as Docker) | Docker bind mounts; machines expose `/mnt/mac` by default | Same as Docker (Docker-compatible CLI) | Free for personal, non-commercial use; Pro $8 per user per month for commercial use |
| Apple `container` | One lightweight VM per container (strongest of the container options) | Vendor: "comparable to" shared-VM containers; not quantified | `--cpus`, `--memory`, `--read-only`, ulimits; defaults 4 CPUs and 1 GB | `--volume` / `--mount`, `readonly` supported; host files appear owned by container root | `spawn("container", ["run", "--rm", ...])` | Apache-2.0, free; needs Apple silicon and macOS 26 |
| `sandbox-exec` | Kernel sandbox profile on the host, same OS, no separate filesystem | Process-spawn cost only | Allow/deny rules for files, network, process; no CPU or memory limits | Same filesystem; restrict by path rules | `spawn("sandbox-exec", ["-f", profile, command, ...])` | Free; but deprecated and profile language undocumented |
| Linux VM (Lima, or Apple Virtualization directly) | Full VM, own kernel | Cold boot per run is slow; practical use is one long-lived VM | VM-level CPU, memory | virtiofs shares or copy via SSH | `spawn("limactl", ["shell", ...])` | Lima is open source (CNCF); VM software free |

## Docker Desktop

- **Isolation.** Docker Desktop runs Linux containers in a Linux VM on the Mac; all containers share that VM and its kernel. File sharing uses VirtioFS by default with the Apple Virtualization framework VMM. Source: [Docker Desktop settings](https://docs.docker.com/desktop/settings-and-maintenance/settings/).
- **Limits.** Per container: `--memory` (min 6 MB), `--cpus`, `--cpuset-cpus`, block I/O flags, `--cap-drop`, `--read-only`, `-u`. Sources: [Resource constraints](https://docs.docker.com/engine/containers/resource_constraints/), [`docker run` reference](https://docs.docker.com/engine/containers/run/). The VM as a whole has CPU, memory (default 50% of host), swap and disk caps in Settings. Source: Docker Desktop settings page above. A PID limit flag was not confirmed from the pages fetched; check `docker run --help` locally.
- **Network.** `--network none` leaves only the loopback device with no external connectivity. Source: [None network driver](https://docs.docker.com/engine/network/drivers/none/).
- **Files.** `-v host:container` bind mount, or `--mount` with read-only option. For PATH: mount the run's working directory read-write and everything else not at all.
- **Exit codes.** Docker reserves 125 (daemon error), 126 (command cannot be invoked), 127 (command not found); other codes are the contained process's own. Source: [`docker run` reference](https://docs.docker.com/engine/containers/run/). The worker must map 125 to an engine fault (not a step failure) and can map 126 and 127 to the existing `failed to start` message.
- **Start-up cost.** Docker does not publish a per-run figure in these pages. Needs measurement. Also the Docker Desktop daemon must be running: a login-time app with a GUI, which matters for a headless Mac mini after restart (see map "sleep or restart behaviour").
- **Licence.** Free for fewer than 250 employees and under $10M annual revenue, personal use, education, non-commercial open source; paid Pro, Team or Business above that. Source: [Docker Desktop license](https://docs.docker.com/subscription/desktop-license/). Docker Engine itself is under different terms but does not run on macOS without a VM.

## OrbStack

- **Isolation.** One shared Linux VM runs all Docker containers, same model as Docker Desktop. Source: [OrbStack docs](https://docs.orbstack.dev/). Linux machines are integrated with the host by default: Mac files appear at `/mnt/mac`, and macOS commands can be run from Linux. Source: [OrbStack machines](https://docs.orbstack.dev/machines/). An "Isolated machines" feature exists on another page; not fetched here. Use containers, not machines, for sandboxing, and do not use the default machine mounts.
- **Start-up.** Vendor claim: "Starts in 2 seconds". This is the app start, not a per-container figure. Source: OrbStack docs home.
- **Limits, network, mounts, worker integration.** OrbStack provides the Docker CLI and engine, so the flags and the `spawn("docker", ...)` worker are the same as above. I did not verify an OrbStack-specific limit page; treat as "same as Docker" until tested.
- **Licence.** Free plan is "Personal, non-commercial use". Pro is $8 per user per month ($96 annual) for commercial use. Source: [OrbStack pricing](https://orbstack.dev/pricing). Whether a family or hobby PATH on the owner's Mac mini counts as personal depends on how PATH is used; hosting a public multi-user site is likely commercial-adjacent. Needs an owner decision or a question to OrbStack.

## Apple `container`

- **Isolation.** "runs a lightweight VM for each container", giving "the isolation properties of a full VM" with minimal utilities to reduce attack surface. This is stronger than Docker or OrbStack, whose containers share one VM kernel. Source: [technical overview](https://github.com/apple/container/blob/main/docs/technical-overview.md).
- **Start-up.** "comparable to containers running in a shared VM". Not quantified. Same source. Needs measurement.
- **Requirements and status.** Apple silicon Mac; supported on macOS 26 (maintainers decline issues on older OS versions); "under active development"; version numbers are product versions, not semver. Source: [repository README](https://github.com/apple/container). The Mac mini's chip and macOS version were not confirmed in this research.
- **Limits.** `-c/--cpus`, `-m/--memory`, `--read-only`, `--tmpfs`, `-u`, `--rm`; defaults 4 CPUs and 1 GB RAM per container; overcommit allowed and host swaps under pressure; memory freed in a container is not returned to the host, so memory-heavy workloads need restarts. Sources: [command reference](https://github.com/apple/container/blob/main/docs/command-reference.md), [resource usage](https://github.com/apple/container/blob/main/docs/resource-usage.md), technical overview. Ulimits have their own how-to page (not fetched).
- **Network.** I found no `--network none`. The command reference lists `container network create --internal` ("Restrict to host-only network") and the networking guide describes isolated networks, available on macOS 26 and later; on macOS 15 networking is limited to isolated containers with no inter-container communication. Sources: command reference, [networking guide](https://github.com/apple/container/blob/main/docs/networking.md), technical overview. Whether an `--internal` network blocks all outbound internet traffic is not stated in these pages. Must test before relying on it.
- **Files.** `--volume host:target[:ro]` or `--mount source=...,target=...,readonly`. Host files appear owned by container root. Source: [volumes guide](https://github.com/apple/container/blob/main/docs/volumes.md). Files the step writes into a bind mount will therefore need an ownership check on the host side.
- **Exit codes.** The command reference does not document exit-code behaviour; test what `container run` returns for the contained process versus its own failures.
- **Licence.** Apache-2.0. Free.

## `sandbox-exec`

- **Status.** The man page states the command is DEPRECATED and tells developers to adopt App Sandbox instead. Source: [sandbox-exec(1)](https://keith.github.io/xcode-man-pages/sandbox-exec.1.html). `sandbox_init(3)` is also deprecated. Source: [sandbox_init(3)](https://keith.github.io/xcode-man-pages/sandbox_init.3.html). Apple developer forum posts note the profile (SBPL) format has never been publicly documented; that is a forum statement, not a first-party doc, so treat as weaker evidence.
- **Isolation.** A kernel policy applied to a host process. Same OS, users and filesystem; only the profile's rules restrict it. It limits files, network and process operations. It does not provide CPU or memory limits, a private filesystem, or a separate kernel. A kernel bug or profile gap is a host compromise.
- **Options.** `-f profile-file`, `-n profile-name`, `-p profile-string`, `-D key=value`. Source: man page above. The named built-in profiles (`kSBXProfileNoInternet`, `kSBXProfileNoNetwork`, `kSBXProfileNoWrite`, `kSBXProfilePureComputation`) are listed in the `sandbox_init(3)` page.
- **App Sandbox** (the replacement) is entitlement-based and applies to signed app bundles, not an arbitrary command line. Source: [App Sandbox Design Guide](https://developer.apple.com/library/archive/documentation/Security/Conceptual/AppSandboxDesignGuide/AboutAppSandbox/AboutAppSandbox.html). It does not fit "spawn an arbitrary program per step".
- **Start-up.** Process spawn only. **Cost.** Free.
- **Fit for PATH.** Cheapest, but deprecated, undocumented, and weakest. Acceptable only as a defence-in-depth layer, not as the multi-user boundary.

## Linux VM (Lima or Apple Virtualization directly)

- **Apple Virtualization framework** supports Linux guests, virtiofs directory sharing, and NAT networking. Source: [Virtualization framework](https://developer.apple.com/documentation/virtualization). Apple `container` and Docker Desktop both build on it.
- **Lima** launches Linux VMs with automatic file sharing and port forwarding; VM types include QEMU, VZ, WSL2, Krunkit and HCS; supports "plain mode"; CNCF Incubating since 2025. Source: [Lima docs](https://lima-vm.io/docs/). Licence file was not read; verify before adoption. Lima's default behaviour of mounting the host home directory was not confirmed from the page fetched; check the template and disable it.
- **Per-run model.** Booting a VM per step is the slowest start-up of all options. The usual design is one long-lived VM and a container or user namespace per step inside it, which is then the same isolation as Docker or OrbStack with more setup. A per-step VM is what Apple `container` already does with a lightweight guest.
- **Worker integration.** `spawn("limactl", ["shell", name, "--", ...])` or SSH. File sharing needs care so that only the run's directory is visible.

## Fit against the map's constraints

Map #711 facts that bear on the choice: V1 host is one Mac mini; one process serves Server, engine and UI; public via Tailscale Funnel; multi-user with per-user Secrets; hostile users are possible (a public Funnel with no auth is a known risk); no admin role.

- A **shared-VM container** (Docker Desktop, OrbStack) isolates a step from the macOS host and from other users' files, if only the run directory is mounted and `--network none` is the default. A container escape lands in the Linux VM, not on macOS, provided the VM does not mount host directories broadly.
- **Apple `container`** adds a VM boundary per step, so one step cannot reach another step's container kernel. Cost is the macOS 26 and Apple silicon requirement, the pre-1.0-style product versioning, and the unconfirmed offline-network story.
- **`sandbox-exec`** gives no filesystem separation or resource limits and is deprecated; it fails the "sandbox, not directly on the host" intent on its own.
- The **licensing** question is real for Docker Desktop (size thresholds) and OrbStack (personal versus commercial). Apple `container` and Lima carry no such fee.
- **Secrets.** Today's `spawn` inherits the engine env. Any sandbox must pass an explicit, minimal env (per-step, per-user) instead.

## Open questions for the owner or the build session

1. Mac mini chip and macOS version (decides whether Apple `container` is possible).
2. Is a public multi-user PATH "commercial" under OrbStack's terms and "professional use in a larger organization" under Docker's?
3. Which guarantee is required: host isolation only, or step-to-step VM isolation too?

## To verify on hardware (not answerable from docs)

- Per-run start-up time for each of Docker Desktop, OrbStack, Apple `container`, for a trivial command, cold and warm.
- Whether Apple `container` can run a step with no outbound network (`--internal` network or otherwise).
- How `SIGTERM` to the `docker run` or `container run` client maps to stopping the contained process, and whether orphan containers survive an engine crash. The `--rm` flag removes a container after it stops, but a hard-killed client may leave one running; plan a reaper by container label or name.
- File ownership and permission of files a container writes into a bind mount (Apple `container` maps owner to root per the volumes guide).
- Behaviour after Mac mini sleep or reboot: does the container runtime start without a GUI login.
- Image supply: which base image has the tools the existing `binary` steps call (the host's `PATH` is not visible inside a container, so a step's `command` must exist in the image). This is a workflow-compatibility change, not just a runtime choice.
