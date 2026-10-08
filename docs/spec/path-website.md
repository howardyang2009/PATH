# PATH website: multi-user hosted mode

This spec is the hand-off for building the multi-user PATH website: Clerk sign-in, per-user visibility
of workflows, templates and runs, and how it runs on the owner's Mac mini. It gathers the decisions of
the wayfinder map [#711](https://github.com/howardyang2009/PATH/issues/711) (origin
[#458](https://github.com/howardyang2009/PATH/issues/458)). Each section links the ticket that holds
the full reasoning. Vocabulary is `CONTEXT.md` (**Requester's view**, **Creator**, **Launcher**,
**User secret**, **Secret store**). The authored layout is ADR 0084 to 0087.

ADRs: [0088](../adr/0088-each-request-sees-its-own-view-and-only-the-creator-writes-a-shared-item.md)
(access rule), [0089](../adr/0089-in-hosted-mode-the-launchers-secret-store-replaces-the-host-environment.md)
(secrets), [0090](../adr/0090-the-user-id-is-the-clerk-sub-verified-on-every-request.md) (identity),
[0091](../adr/0091-a-hosted-run-executes-in-one-vm-per-engine-invocation.md) (run executor),
[0092](../adr/0092-v1-runs-on-a-clerk-development-instance-over-tailscale.md) (Clerk instance and
ingress).

## 1. Scope

- **Two modes.** Local mode (no auth, user `local`, runs in process) stays the default and does not
  change except where this spec says so. Hosted mode turns on by config.
- **Access rule.** A user reads shipped, shared and own files, never another user's private files or
  runs. Anyone adds to shared; only the creator edits or deletes a shared item. No admin role.
- **Runs are private** to the launcher.
- **Storage stays local**: SQLite (`better-sqlite3`), local blobs, the `users/` and `shared/`
  folders in the project directory. No Postgres or Supabase.
- **One host**: the owner's Mac mini (M2, 8 cores, 24 GB). One process serves Server, engine,
  Viewer and Designer on one origin.
- **Out of scope**: cloud hosting, an admin role, a usage panel, notifications, a user report button,
  merge of user data, an allowlist egress proxy (until its trigger).

## 2. Identity ([#705](https://github.com/howardyang2009/PATH/issues/705), ADR 0090)

- The user id is the raw Clerk `sub`, checked against `^user_[A-Za-z0-9]+$`; `local` is refused as a
  hosted id.
- Every request is verified with `verifyToken` from `@clerk/backend` (`jwtKey`,
  `authorizedParties` = the exact public origin). No session cache, no user table.
- Clients send `Authorization: Bearer <token>`. In hosted mode every `/v0/*` door answers `401`
  without a valid token, except `GET /v0/auth-config` and the health route. Static Viewer and
  Designer assets stay public.
- Hosted mode is on when `CLERK_JWT_KEY` and `PATH_ALLOWED_ORIGIN` are set. A half-configured setup
  refuses to start. Hosted mode also needs `CLERK_PUBLISHABLE_KEY` (served by `/v0/auth-config`) and
  refuses to start without it.
- Sign-up is open (Clerk `public`). PATH uses a separate Clerk application named PATH in the owner's
  existing Clerk account (not the AIBlocks application). Keys stay out of the repository.

## 3. Access rule ([#706](https://github.com/howardyang2009/PATH/issues/706), ADR 0088)

- Every door works on the requester's view (shipped, shared, own). Id uniqueness and first-root-wins
  are checked per view.
- Another user's path answers `404` on every workflow door.
- A host-level SQLite table maps each shared item's `(project path, kind)` to its creator `sub`.
  Create stamps it, update keeps it, delete removes it. A shared file with no creator row is
  read-only for everyone. Local mode stamps `local`.
- A write by a non-creator answers `403`. Discovery and the template list carry a Server-decided
  `read_only` per row; add `read_only` to `WorkflowSummary` (today only `TemplateSummary` has it).
- In hosted mode the tree load refuses a ref outside the launcher's view.

## 4. Runs ([#707](https://github.com/howardyang2009/PATH/issues/707))

- A run lives in its launcher's store: `users/<user-id>/.path/`, or the project `.path` for `local`.
  No `launched_by` column.
- Every `/v0/runs/*` door resolves only in the requester's store; another user's run id is `404`.
- Hosted mode never serves the project `.path`.
- A deleted workflow keeps its run history; Resume and Complete answer `404` with a message.
- Resume and Complete use the current file of a shared workflow.

## 5. Run executor ([#709](https://github.com/howardyang2009/PATH/issues/709), ADR 0091)

- Hosted mode uses `SandboxedRuns`: one Apple `container` VM per engine invocation (Start, Resume,
  Complete), behind a `SandboxRuntime` seam with Docker or OrbStack as fallback.
- The host mounts the root's blob directory, republishes streamed events to `RunEventHub`, and
  validates rows the VM exports at exit.
- One image per PATH release with Node, the engine build, plugin folders, `git`, `curl`, `python3`
  and `jq`.
- 4 CPUs and 4 GB per VM, 1 h per invocation, at most 3 VMs overall.
- Cancel signals the engine and kills the VM after 10 s. A lost VM marks `running` rows `failed`
  ("sandbox lost"). A reaper at Server start removes orphan VMs by label.

## 6. User secrets ([#708](https://github.com/howardyang2009/PATH/issues/708), ADR 0089)

- In hosted mode `$env` resolves against the launcher's Secret store, never the host environment.
- Rows in the user's `path.db`, AES-256-GCM under `PATH_SECRETS_KEY`, key id per row.
- `PUT /v0/secrets/:name`, `GET /v0/secrets` (names and `updated_at`), `DELETE /v0/secrets/:name`.
  No door returns a value; `404` in local mode.
- The whole store becomes the VM environment and every value is masked.

## 7. Clients ([#710](https://github.com/howardyang2009/PATH/issues/710))

- **Mode discovery**: public `GET /v0/auth-config` returns `{ mode, publishableKey }`.
- **Sign-in**: `@clerk/clerk-js` in client-core, lazy-loaded only in hosted mode: `openSignIn`
  modal and `UserButton`. Without a session the app shows only the sign-in screen.
- **Token**: `PathApiClient` takes a `getToken` option and sends the Bearer header on REST `send`,
  `requestBlob` and the SSE stream. Fix `connect.ts`, which does not pass the injected fetch to the
  stream today.
- **Session loss** (`401`): open the sign-in modal over the current screen, retry after sign-in. A
  different user signing in reloads the app.
- **Sign-out**: `UserButton` in both headers; one session for both apps.
- **Lists**: the mine / shared / shipped tree stays. A read-only shared row shows a lock and
  "read-only". No creator names. The runs list does not change.
- **Writes**: on a read-only item the Designer disables Save and Delete ("Read-only: shared by
  another user") and offers Save as. A late `403` shows "Read-only: only the creator can save. Use
  Save as."; a `404` shows "No longer available".
- **Workflow Save as** gets the mine / shared picker that templates have, default mine, in both
  modes.
- **Secrets page**: Viewer only, `/viewer/secrets`, from the user menu, hosted mode only: list names,
  set (write-only input), delete with confirm.
- **Local mode** renders as today: no Clerk load, no user menu, no Secrets page.

## 8. Abuse limits ([#713](https://github.com/howardyang2009/PATH/issues/713))

| Limit | Value | At the limit |
|---|---|---|
| Running VMs per user | 1 (3 overall) | launch stays `pending`; a free slot goes to the oldest `pending` launch of a user with nothing running |
| VM time per user | 2 h per rolling 24 h | `429` "budget used, try at <time>"; running VMs finish |
| Storage per user (store, runs, blobs, authored files) | 1 GB | `507` on launch, write and VM import; reads and deletes work |
| Free disk on host | 5 GB floor | all launches refused |
| Requests per user | 120 per minute (SSE counts once) | `429` with `Retry-After` |
| Request body | 1 MB | `413` |
| Shared items per user | 50 | `403` |
| Authored file size | 1 MB | `403` |

- Rate counters live in Server memory. VM-time usage lives in a host-level table next to the creator
  table. Storage is measured on demand and cached per user.
- All limits are config defaults plus a per-user override map keyed by user id. The map lives in
  `.path/limits.json`, read at boot, for example
  `{"users": {"user_abc": {"requestsPerMinute": 0, "maxSharedItems": 0}}}`. Request-limit keys:
  `requestsPerMinute`, `maxBodyBytes`, `maxSharedItems`, `maxFileBytes`. Run-limit keys:
  `maxRunningVms`, `vmSecondsPerDay`, `maxStorageBytes`; 0 blocks every launch of that user. The
  free-disk floor is host-wide. A malformed file refuses boot. Local mode applies no limits.
- Run limits gate every VM launch: Start, Resume and Complete. The free-disk floor and the storage
  limit answer `507`, the VM-time budget `429` with `Retry-After`. Storage is measured fresh at
  launch and VM import, and reused for 30 s on writes while under the limit. A queued launch is
  checked again when it gets its slot. A VM that a previous Server process left running is counted
  up to the next boot, at most its 1 h limit.
- The request rate counts over a sliding minute. A body up to 8 MB past the cap is read before the
  `413`; a longer one gets the `413` at once and its connection closed.
- Users see only the message when a limit hits.

## 9. Operator tools and runbook

**Abuse runbook** ([#713](https://github.com/howardyang2009/PATH/issues/713)), mildest first:

1. Stop new sign-ups: Clerk sign-up mode to invite-only.
2. Slow one user: set their overrides to 0 (VM time, running VMs, shared items).
3. Block one user: ban in Clerk; effective within 60 s.
4. Take the site offline: `tailscale funnel off` (or stop the tunnel after the move).

**`path-server remove-shared <path>`** ([#723](https://github.com/howardyang2009/PATH/issues/723)):
safe while the Server runs. Moves the file to `.path/quarantine/<date>/` for 30 days (or `--purge`),
removes the creator row and logs path, creator, time and reason. `--find-copies` reports files under
`users/*/` with the same content hash and never touches them. No notice to the creator.

**`path-server remap-user`** ([#720](https://github.com/howardyang2009/PATH/issues/720)): offline
(refuses while the Server runs). Copies `users/<old>/` and the store (the project `.path` for
`local`) to `users/<new>/`, rewrites the `users/<old>/` prefix in `runs.workflow_path` and in refs
inside authored files, and moves creator rows to the new id. Does not move VM-time usage; prints a
reminder to edit the override map. Refuses a non-empty target. Verifies with file counts, row counts
and `PRAGMA integrity_check`; deletes the source only with `--delete-source`. `--dry-run` prints
pairs, sizes, counts, rewrites and conflicts. Used once for `local` to the owner's `sub`, and at the
move to production with pairs read from Clerk `external_id`.

**Backup** ([#722](https://github.com/howardyang2009/PATH/issues/722)): `path-server backup` makes a
consistent snapshot (SQLite online backup API for every `path.db` and the host DB, plus blobs,
`users/` and `shared/`); `restic` stores it encrypted in Backblaze B2. Nightly via `launchd`, keep 7
daily, 4 weekly, 6 monthly. `path-server backup verify` restores into a temporary directory, runs
`PRAGMA integrity_check` and boots a read-only Server; run it quarterly. `path-server
rotate-secrets-key` re-encrypts secrets under a new key id.

## 10. Network exposure

**Now** ([#721](https://github.com/howardyang2009/PATH/issues/721)): Funnel is off since 2026-10-05.
PATH is tailnet-only through `tailscale serve`. Trusted testers only, through Tailscale node sharing.
In local mode the Server answers `403` to any request whose `Host` is a `*.ts.net` name and that
carries no `Tailscale-User-Login` header (a Funnel request); `PATH_FUNNEL_GUARD=off` switches this
guard off, and hosted mode does not apply it ([#726](https://github.com/howardyang2009/PATH/issues/726)).

**Egress** ([#724](https://github.com/howardyang2009/PATH/issues/724),
[#740](https://github.com/howardyang2009/PATH/issues/740)): VMs run on one fixed network
(`container network create path --subnet 192.168.100.0/24`). A `pf` anchor `path`, loaded at boot by
the `launchd` daemon `com.path.egress`, blocks `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`,
`169.254.0.0/16`, `100.64.0.0/10`, ports 25, 465 and 587, and all IPv6 from the network. The host
gateway answers DNS (port 53) only. Everything else is allowed. No bandwidth cap. The daemon adds
`anchor "path"` to the main ruleset itself, since macOS updates can replace `/etc/pf.conf`. Only root
can query `pf`, so the daemon writes `/var/run/path-egress.status` (boot time, `pf` status, anchor
rules); hosted mode refuses to boot unless that file is from this boot, `pf` is enabled and the
anchor has its block rules. Files and steps: `packages/server/sandbox/egress/`. An allowlist proxy waits for its trigger (an abuse complaint, signs of scanning, or the move to
production).

**Move to production** ([#712](https://github.com/howardyang2009/PATH/issues/712), ADR 0092):
trigger-based. Buy a domain, move DNS to Cloudflare, run Cloudflare Tunnel, import users into the
production Clerk instance with `external_id` = old `sub`, run `path-server remap-user`, change
`authorizedParties` to the new origin.

## 11. Hosted-mode gate

Funnel (or the tunnel) goes public only when all are true. Hosted mode refuses to boot when a
Server-side item is missing.

- [ ] Hosted mode on: `CLERK_JWT_KEY`, `PATH_ALLOWED_ORIGIN` and `CLERK_PUBLISHABLE_KEY` set
- [ ] `SandboxedRuns` active; in-process runs refused in hosted mode
- [ ] `PATH_SECRETS_KEY` set (read from the macOS Keychain)
- [ ] Abuse limits on
- [ ] `pf` anchor `path` loaded
- [ ] A backup has run and `backup verify` passed (owner check)

## 12. Owner checklist (host setup, not code)

- `pmset`: system sleep 0, `autorestart` 1. Keep FileVault; unlock by hand after an outage; use
  `sudo fdesetup authrestart` for planned updates.
- Run the Server as a `launchd` LaunchAgent with `KeepAlive`.
- Store `PATH_SECRETS_KEY` in the Keychain, with an escrow copy in a password manager, never in the
  data backup.
- Install the `path` network, the `pf` anchor and its `launchd` daemon once: run
  `packages/server/sandbox/egress/install.sh` as the login user (it asks for `sudo` once). Rerun it
  when the `path` network is recreated, since the anchor names its IPv6 prefix.
- Per PATH release, build the run image with `packages/server/sandbox/build-run-image.sh` and set
  `PATH_SANDBOX_IMAGE` to its tag. Every VM joins the `path` network.
- After each reboot, start the `container` service as the login user (`container system start`)
  before the Server; it does not start on its own.
- After install and after each reboot, run `packages/server/sandbox/egress/check.sh <run image>`:
  every blocked target must time out and an internet HTTPS request must work.
- Create the Clerk application PATH (development instance, open sign-up).
- Sign in once, then run `path-server remap-user` from `local` to the owner's `sub`.

## 13. Build prerequisites

Confirm before building on them; if one fails, hosted mode stays off until it is fixed:

- Apple `container` runs on macOS 27 on the Mac mini.
- No-network behaviour of `container`, and that `pf` filters `container` VM traffic.
- Clerk `clerk-js` modal and Bearer tokens work on a development instance over `tailscale serve`.

## 14. Suggested build order

1. Local-mode Funnel guard (§10). Small, and closes a live risk.
2. Per-request user id in the authored layout and stores; `read_only` on `WorkflowSummary`.
3. Clerk verification, `/v0/auth-config`, `401`, fail-closed boot (§2).
4. Access rule and creator table (§3); run doors per store (§4).
5. Clients (§7).
6. Secret store (§6).
7. `SandboxedRuns` and `pf` egress (§5, §10).
8. Abuse limits (§8).
9. Operator tools: backup, remap, remove-shared, rotate (§9).
10. Gate check (§11), then open Funnel.
