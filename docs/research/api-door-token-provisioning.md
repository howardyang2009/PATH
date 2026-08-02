# API-endpoint door — `GITHUB_TOKEN` provisioning and verification

Resolves [#132](https://github.com/howardyang2009/PATH/issues/132), the credential half of [map #129](https://github.com/howardyang2009/PATH/issues/129)'s frontier. Enabling work: it decides nothing about the door. **It records no verdict against [the rubric](api-door-rubric.md)** — that is [#134](https://github.com/howardyang2009/PATH/issues/134)'s file, and where a fact below happens to touch an entry, it is named so the boundary is visible rather than left for a reader to police.

**Date:** 2026-08-02. **Verified from:** macOS 15 (arm64), `curl 8.7.1`, `gh` 2.96.0, against live `api.github.com` from a residential IP.

**No token value appears in this file, and none may be added to it.** What is recorded is the variable name, the source, the permissions, and the observed limits. The workflow references the credential only as `{"$secret": {"$env": "GITHUB_TOKEN"}}` and never carries its value.

---

## 1. What the pipeline actually needs: authentication, not scope

`howardyang2009/PATH` is public, and the ticket asked this be confirmed rather than assumed. It was confirmed the only way that settles it — **every candidate endpoint was called with no credential at all**, and every one returned `200`:

| Endpoint (shape [#131](https://github.com/howardyang2009/PATH/issues/131) may choose from) | No credential | §2 PAT (no permissions) | Rate-limit resource |
| --- | --- | --- | --- |
| `GET /rate_limit` | `200` | `200` | `core` (not charged) |
| `GET /repos/howardyang2009/PATH` | `200` | `200` | `core` |
| `GET /repos/{owner}/{repo}/issues?state=closed` | `200` | `200` | `core` |
| `GET /repos/{owner}/{repo}/pulls?state=closed` | `200` | `200` | `core` |
| `GET /repos/{owner}/{repo}/compare/{base}...{head}` | `200` | `200` | `core` |
| `GET /repos/{owner}/{repo}/commits` | `200` | `200` | `core` |
| `GET /search/issues?q=repo:…+is:issue+is:closed+closed:>=DATE` | `200` | `200` | **`search`** |

(The `gh` OAuth credential of §2 returns `200` on all seven too — it was the first credential tried, and §7 records why that was not enough.)

So **no scope grants access here**. The token exists for the rate limit and for nothing else — which is what makes §2's choice cheap.

One header invites the opposite conclusion and should not be believed — and it is not even reliably present. Calling with the **`gh` OAuth credential**, `GET /repos/{owner}/{repo}` and the `issues` list returned `x-accepted-oauth-scopes: repo`, while `pulls`, `compare`, `commits` and `search` returned it **empty**. With **no credential**, and with the **fine-grained PAT**, the header is absent everywhere (§7). It names the scopes that *would* be accepted for the private case, not scopes required for this one — which is why the evidence above is the `200`s themselves, gathered without reference to it.

## 2. The source: a fine-grained PAT with no repository permissions

**Decided by the human** (the delegation plan splits this ticket at the secret boundary: acquisition is human, verification is AI). Recorded so the run reproduces:

- **Kind:** fine-grained personal access token, **"Public Repositories (read-only)"**, i.e. **no repository permissions and no account permissions granted**. Per §1 that is sufficient for every endpoint above, and it still receives the full authenticated limit — the limit is per-user, not per-scope.
- **Owner:** the `howardyang2009` account.
- **Expiry:** set by the human, short by preference — nothing automated depends on this token, the run is on demand, and §7 records what re-issuing costs (one re-run of §6, nothing else).

**Rejected: `gh auth token`.** It is free and already present (`gh auth status` shows an active OAuth credential in the macOS keyring, scopes `gist, read:org, repo, workflow`), and it was the first credential §1 and §4 were measured with — before the PAT existed to measure them again. It was rejected as the *recorded* source because those scopes carry **write** access to every repository on the account — roughly the whole account's blast radius — for a job §1 shows needs no scope whatsoever.

The gap matters more here than it usually would, for a reason this file states and does not resolve: [#133](https://github.com/howardyang2009/PATH/issues/133) runs this credential through a live pipeline whose **exposure surface is not yet settled** — whether the token reaches `curl` through argv or some other transport is [#131](https://github.com/howardyang2009/PATH/issues/131)'s call to make and the human's to ratify, and rubric entry `Q5` turns on it. Choosing a zero-permission token is what makes that question safe to answer either way: it costs nothing if the value does reach the process table, and nothing is given up if it does not.

`gh auth token` remains available as an ad-hoc convenience for read-only poking around. It is not the run's credential.

## 3. Where it lives, and how a run picks it up

- **Variable name: `GITHUB_TOKEN`.** Fixed by #129's locked decision — the workflow says `{"$secret": {"$env": "GITHUB_TOKEN"}}`.
- **At rest: in the human's password manager**, and nowhere else. **Not** in a dotfile, **not** in `.envrc`, **not** in the macOS Keychain as a second copy, **not** in any file inside this repository, and not in shell history — copy it out of the manager and into the invoking shell in a way that leaves no command line for the shell to record (`read -rs GITHUB_TOKEN && export GITHUB_TOKEN`, or the manager's own CLI).
- **At run time:** exported in the shell that invokes `path run`. The engine resolves `$env` from `process.env` at run start, and `binary` steps inherit the process environment (`packages/engine/src/binary-worker.ts`), which is the mechanism the `env-secret-probe` acceptance workflow pins down (see [`docs/acceptance-workflow/env-secret-probe.NOTES.md`](../acceptance-workflow/env-secret-probe.NOTES.md)).
- **Consequence for #133:** the run needs no setup step, no config file and no engine change — one export in the invoking shell is the whole of it.

## 4. Verified limits

Measured, not quoted from documentation — the `x-ratelimit-*` headers came back on **every** call, authenticated and not:

| Resource | No credential | §2 PAT (no permissions) | Window |
| --- | --- | --- | --- |
| `core` (everything but search) | **60** | **5000** | per hour |
| `search` | **10** | **30** | per **minute** |

The authenticated column is what the **recorded** credential returns, observed (§7) — not what a broader token returns and not what the documentation promises. Granting the PAT no permissions costs nothing in limit: the quota is per user, not per scope.

`x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-used`, `x-ratelimit-resource` and `x-ratelimit-reset` were all present on every response, authenticated and not. Recorded here only as the headers-come-back-as-expected check the ticket asks for; what it costs a `binary` step to *read* one is rubric entry `Q3`, which #134 records and this file does not.

Authenticated `GET /rate_limit` reports the full per-resource table (`core` 5000, `search` 30, `graphql` 5000, plus resources this pipeline never touches). It is not itself charged against `core`.

## 5. No endpoint needed more access; `/search/issues` has a different budget

The ticket asks for "any endpoint that turned out to need more access than expected". **None did** — §1 is the whole answer on access.

One endpoint is nonetheless not interchangeable with the others, and #131 should have the fact before it fixes the endpoint list: **`/search/issues` is a separate rate-limit resource at 30 requests per minute** (§4), not part of the 5000/hour `core` pool. Per minute, not per hour, and authenticating raises it 3× rather than 83×.

Stated as a fact and nothing more. Which endpoints the pipeline calls is #131's decision, what a limit costs is #134's to record, and rate-limit *handling* is [#109](https://github.com/howardyang2009/PATH/issues/109)'s retry/resume door, which #129 puts out of scope — observing a number is none of the three.

## 6. Reproducing the verification

One authenticated call per endpoint, checking status and rate-limit headers. The credential is passed to `curl` on **stdin** via `--config -`, so it never enters argv:

```sh
printf 'header = "Authorization: Bearer %s"\nheader = "Accept: application/vnd.github+json"\nurl = "%s"\nsilent\ndump-header = "hdr.txt"\noutput = "body.json"\nwrite-out = "status=%%{http_code}\\n"\n' \
  "$GITHUB_TOKEN" "https://api.github.com/rate_limit" | curl --config -
grep -iE '^x-ratelimit-|^x-oauth-scopes' hdr.txt
```

Expected, and observed on the §2 PAT: `status=200`, `x-ratelimit-limit: 5000`, `x-ratelimit-resource: core`, and no `x-oauth-scopes` line at all.

**Why the value goes in on stdin here.** This probe runs in a plain shell, not in the engine, and the ticket's own rule is that the value must not be pasted anywhere it can be read back — argv included. **It carries no implication for #131 or #133.** A `binary` step's stdin is already spoken for by format §4.2, which writes the step's input object there; that collision is the whole of the question `Q5` reserves, and it does not arise in a shell. Nothing in this snippet says a workflow can do the same thing, and #133 must not read it as saying so.

## 7. What was verified, on which credential

**Everything above was verified twice, on two credentials.** §1 and §4 were first measured with the `gh` OAuth credential and with none at all; the §2 token was minted afterwards and **the whole endpoint set was re-run against it**, since a source that is recorded but never exercised is a decision, not a verification, and #133 would have started on an inference.

The zero-permission PAT behaves exactly as §1 predicts. Every endpoint in the §1 table returned `200`, `core` reported `x-ratelimit-limit: 5000`, `search` reported `30`, and **both `x-oauth-scopes` and `x-accepted-oauth-scopes` were absent from every response** — fine-grained tokens send neither, which is why §1's scope reasoning had to rest on the unauthenticated `200`s rather than on a header. Nothing needed a permission the token does not have.

**What remains open is not a fact but a lifetime.** The PAT expires; when it does, mint a replacement with the §2 settings and re-run §6 once to confirm nothing about GitHub's public-read policy has moved. No other step re-derives.
