# PATH is served at path.rheinwegde.de through Cloudflare Tunnel

**Status:** accepted. Refines the move to production in [ADR 0092](0092-v1-runs-on-a-clerk-development-instance-over-tailscale.md).

## Amendment (2026-10-24)

The move is done, without the user import: the development users were not moved to the production
Clerk instance and `path-server remap-user` was not run. Every user signs up again and starts empty.
Funnel is off.

## Context

ADR 0092 left the production domain open. The owner chose `path.rheinwegde.de`. Cloudflare
Registrar does not sell `.de`. A static host such as Vercel cannot run the Server: it needs a local
store, runs of up to 1 h, in-memory live events and one VM per engine invocation
([ADR 0091](0091-a-hosted-run-executes-in-one-vm-per-engine-invocation.md)).

## Decision

1. **Registrar INWX, DNS on Cloudflare.** `rheinwegde.de` is registered at INWX; its nameservers
   point to a Cloudflare Free zone.
2. **Cloudflare Tunnel to the Mac mini.** `cloudflared` routes `path.rheinwegde.de` to the local
   `path-server` port. No router port is opened.
3. **One origin.** The Server keeps serving the Viewer, the Designer and `/api` on that hostname
   ([ADR 0027](0027-two-bundles-one-origin-named-mounts-with-root-redirect.md)). The bundles do not
   move to a separate static host.

## Considered options

- **Bundles on Vercel, Server on the Mac mini**: needs CORS, a cross-origin Clerk setup and a second
  public hostname for the API, and solves nothing the tunnel does not.
- **Cloudflare Registrar**: does not support `.de`.

## Consequences

- The local-mode guard must refuse every non-local, non-tailnet `Host` before the tunnel opens
  ([#785](https://github.com/howardyang2009/PATH/issues/785)); today it refuses only `*.ts.net`.
- The rest of the move follows ADR 0092: Clerk production on `rheinwegde.de`, user import and
  `path-server remap-user`, `authorizedParties` set to the new origin, Funnel retired.
