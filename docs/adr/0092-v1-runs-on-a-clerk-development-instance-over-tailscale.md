# V1 runs on a Clerk development instance over Tailscale

**Status:** accepted.

## Context

The hosted website runs on the owner's Mac mini. A Clerk production instance needs a domain the owner
controls, and the app must sit on that domain. Tailscale Funnel serves only `*.ts.net` names and
cannot carry a custom domain. The first users are a small group.

## Decision

1. **V1 uses a Clerk development instance** in a separate Clerk application named PATH, on the
   Tailscale `*.ts.net` origin. Its limits are accepted: 100 users, a "Development" badge, and the
   dev-browser token in the querystring.
2. **Sign-up is open** (Clerk `public`). Abuse limits in the Server bound what one user can do.
3. **Funnel stays off until the hosted-mode gate is met** (see the website spec). Until then PATH is
   tailnet-only through `tailscale serve`.
4. **The move to production is trigger-based**: users near the 100-user cap, or development-instance
   limits causing a real problem. At the move the owner buys a domain, moves its DNS to Cloudflare
   and runs Cloudflare Tunnel (`cloudflared`) on the Mac mini. Funnel is retired for public traffic.
5. **Users are imported, not re-registered.** Before the new domain opens, every development user is
   created in production with the Clerk Backend API, with `external_id` set to the old `sub`.
   `path-server remap-user` then moves each user's data to the new `sub`.

## Considered options

- **Production from day one**: a domain and a new ingress before anyone has used the site.
- **Router port-forward with Caddy**: exposes the home IP and needs dynamic DNS.
- **A VPS reverse proxy into the tailnet**: adds a cloud host to a deliberately single-host setup.
- **Reusing the AIBlocks Clerk application**: shares its user pool, 100-user cap and settings.

## Consequences

- Clerk itself calls a development instance "not suitable for production"; v1 accepts that for a
  small group.
- Every user id changes at the move, so the remap tool is part of the move, not optional.
