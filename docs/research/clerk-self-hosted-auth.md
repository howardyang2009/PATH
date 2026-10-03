# Clerk in front of a self-hosted Node Server

Research for issue #703 (child of wayfinder map #711). Primary sources only: Clerk's own documentation at clerk.com/docs, fetched 2026-10-03. Claims are quoted or paraphrased from the cited page. Items I could not confirm in a primary page are marked **Unconfirmed**.

## Question

What does Clerk need to run in front of `@path/server`, which serves the Viewer and Designer from one origin on a Tailscale Funnel `*.ts.net` host, with no custom domain owned yet?

## Short answer

1. A Clerk **production instance requires a domain the owner controls**. The `*.ts.net` name does not qualify. Until the owner has a domain, only a development instance is possible, and it is "not suitable for production workloads" and capped at 100 users.
2. Server-side verification in plain Node needs no framework. Use `verifyToken` from `@clerk/backend`, or hand-roll RS256 JWT verification against the instance's JWKS or PEM public key. Always check `azp` against the known origin.
3. In the Vite client, use Clerk's React SDK. It reads `VITE_CLERK_PUBLISHABLE_KEY`. Same-origin requests carry the `__session` cookie automatically.
4. Free (Hobby) plan limits are not a blocker for v1 (50,000 monthly retained users). The blockers are the domain and the plan features listed below.

## 1. Server-side verification in plain Node

Source: [Manual JWT verification](https://clerk.com/docs/guides/sessions/manual-jwt-verification), [verifyToken()](https://clerk.com/docs/reference/backend/verify-token), [authenticateRequest()](https://clerk.com/docs/reference/backend/authenticate-request), [Session tokens](https://clerk.com/docs/guides/sessions/session-tokens).

- **Where the token is.** Same-origin requests carry it in the `__session` cookie. Cross-origin requests carry it in the `Authorization` header.
- **Lifetime.** The session token is short-lived (60 seconds). The client SDK refreshes it on a 50-second interval ([How Clerk works](https://clerk.com/docs/guides/how-clerk-works/overview)). The server must not cache a verified result beyond `exp`.
- **Option A, SDK.** `@clerk/backend` exposes `verifyToken(token, options)`. Options: `secretKey` (network-based) or `jwtKey` (PEM public key, "networkless"), `authorizedParties`, `audience`, `clockSkewInMs` (default 5000). It returns the payload (`sub` = user id, `sid`, `exp`) or throws `TokenVerificationError`. The docs state you must provide either `jwtKey` or `secretKey`.
- **Option B, `authenticateRequest(request, options)`.** Takes a standard `Request` and returns `status` of `signed-in`, `signed-out` or `handshake`. The docs name only Next.js; plain Node use is **Unconfirmed** in the page. It needs a Fetch API `Request`, so a Node `http` handler would have to build one. The `handshake` status exists for server-rendered apps and adds redirect handling. A plain API server does better with `verifyToken`.
- **Option C, manual.** Per the manual guide: get the key from `https://api.clerk.com/v1/jwks`, from the Frontend API URL plus `/.well-known/jwks.json`, or from the Dashboard (PEM). Verify with RS256, then check `exp`, `nbf`, and that `azp` equals one of the known origins ("this prevents CSRF attacks"; skip if the claim is absent).
- **Claims.** Default v2 claims include `sub`, `sid`, `exp`, `iat`, `iss`, `jti`, `azp`, `fva` ([Session tokens](https://clerk.com/docs/guides/sessions/session-tokens)). `sub` is the stable user id to key per-user files and runs.
- **Networkless mode** (`jwtKey`) means no Clerk call per request. This fits the local-SQLite, no-network-hop goal in #711. Hosted mode only; local mode skips all of it.

## 2. Browser SDK in a Vite client

Source: [Environment variables](https://clerk.com/docs/guides/development/clerk-environment-variables), [ClerkProvider (React)](https://clerk.com/docs/react/reference/components/clerk-provider).

- Env var in Vite: `VITE_CLERK_PUBLISHABLE_KEY`. Publishable key is `pk_test_` (development) or `pk_live_` (production). Secret key is `CLERK_SECRET_KEY` (`sk_test_` / `sk_live_`), server only.
- `ClerkProvider` wraps the app. `useAuth().getToken()` returns the short-lived JWT for an `Authorization: Bearer` header when a cookie is not enough.
- The publishable key encodes the Frontend API (FAPI) URL, so the client finds the instance from the key alone ([How Clerk works](https://clerk.com/docs/guides/how-clerk-works/overview)).
- Viewer and Designer are separate Vite apps served by one origin. Each needs the same publishable key. Per-app wiring is for the build tickets, not decided here.

## 3. Development vs production instance

Source: [Managing environments](https://clerk.com/docs/guides/development/managing-environments), [How Clerk works](https://clerk.com/docs/guides/how-clerk-works/overview), [Deploy to production](https://clerk.com/docs/guides/development/deployment/production).

| | Development | Production |
|---|---|---|
| Keys | `pk_test_` / `sk_test_` | `pk_live_` / `sk_live_` |
| User cap | 100 users; data cannot move between instances | Plan limits |
| Client token | `__clerk_db_jwt` in the querystring (cross-site to `accounts.dev`) | `__client` HttpOnly cookie on the FAPI subdomain (same-site via CNAME) |
| FAPI host | `<slug>.clerk.accounts.dev` | Subdomain of your domain |
| OAuth | Shared Clerk credentials for some providers | Your own credentials per provider |
| Fit | "Not suitable for production workloads" | Production |

- A development instance runs from any origin Clerk detects at runtime; the dev host is "dynamically detected". A web search summary said dev keys work through ngrok tunnels. I did not find that stated on a Clerk page, so treat a `*.ts.net` dev instance as **Unconfirmed** and test it.
- Settings that do not copy from dev to prod: SSO connections, Integrations, Paths.

## 4. Does production need a domain the owner controls? Yes.

- [Deploy to production](https://clerk.com/docs/guides/development/deployment/production) lists prerequisites: "You will need to have a domain you own" and "You will need to be able to add DNS records on your domain". DNS records provide session management and domain-verified emails. Propagation can take up to 48 hours.
- [Managing environments](https://clerk.com/docs/guides/development/managing-environments): "You must associate a production domain within the Clerk Dashboard."
- A `*.ts.net` name is owned by Tailscale. The owner cannot add a CNAME there. The prerequisite is not met.
- Provider-managed domains: the [Frontend API errors](https://clerk.com/docs/guides/development/errors/frontend-api) page documents `FeatureRequiresCustomDomain` (HTTP 403): a feature is blocked "because your instance only uses a provider domain (like vercel.app)". Clerk's docs do not say whether `ts.net` counts as a provider domain. Whether a production instance can be created at all on such a name is **Unconfirmed**; the stated prerequisite says no.
- Production keys enforce origin: `Production Keys are only allowed for domain 'your-domain.com'` ([troubleshooting](https://clerk.com/docs/guides/development/troubleshooting/using-production-keys-in-development)). Non-standard ports can fail origin validation; port 443 (what Funnel serves) is fine.
- The FAPI CNAME lives on a subdomain of the owned domain. The app itself would also need to be served from that domain or a subdomain of it, so the owner's domain must point at the Mac mini. How to do that with Tailscale Funnel is a hosting question for a later ticket.
- Proxy option: Clerk documents [proxying the Frontend API](https://clerk.com/docs/guides/dashboard/dns-domains/proxy-fapi) as a CNAME alternative. It still sits on a production domain, so it does not remove the domain requirement. I only read the search listing for this page.
- Satellite domains share a session from a primary domain and "require a paid plan for production use" ([Satellite domains](https://clerk.com/docs/guides/dashboard/dns-domains/satellite-domains)). They do not help here: they need a primary domain too.

## 5. Cookies and CORS on one origin

Source: [How Clerk works](https://clerk.com/docs/guides/how-clerk-works/overview), [Subdomain allowlist](https://clerk.com/docs/guides/dashboard/dns-domains/subdomain-allowlist), [Manual JWT verification](https://clerk.com/docs/guides/sessions/manual-jwt-verification).

- Server, Viewer and Designer on one origin means API calls are same-origin. The `__session` cookie (app domain, not HttpOnly, 60 seconds) rides along. No `Authorization` header and no CORS config on the PATH Server is needed for this path.
- The `__session` cookie is "strictly scoped to prevent subdomain sharing". The `__client` cookie lives on the FAPI subdomain, not the app origin.
- FAPI, not the PATH Server, handles the cross-origin requests from the browser. By default it "accepts cross-origin requests from any subdomain of your root domain". Clerk recommends an explicit subdomain allowlist in production, because a compromised sibling subdomain could attack auth flows.
- Set `authorizedParties` to the exact public origin of the Server. This is the CSRF guard for cookie-carried tokens. Without it a sibling subdomain could mint a token that passes signature checks.
- Cookie size: most browsers cap cookies at 4 KB. Large custom claims in the session token can break auth. Keep claims default.
- Dev instance, one caveat: the client token travels in a querystring (`__clerk_db_jwt`), not a cookie. Not for public use.

## 6. Free (Hobby) plan limits

Source: [Pricing](https://clerk.com/pricing).

- 50,000 monthly retained users (MRU) per app; 100 monthly retained organizations. A user does not count until they return 24+ hours after signup. One month grace to upgrade after exceeding either limit.
- Unlimited applications; up to 3 dashboard seats; 5 user impersonations.
- Not included: passkeys, biometric sign-in, MFA, SSO; custom password requirements; custom email templates.
- 1-day application log retention; community support only.
- API keys: 1,000 creations and 100,000 verifications per month. M2M tokens: 2,500 and 100,000.
- Satellite domains need a paid plan in production.
- Pricing pages change often. Re-check before committing.

## Implications for map #711

- The "domain the owner controls" item in #711 is confirmed as needed for Clerk production. Interim path: development instance (100-user cap, querystring client token, "not suitable for production"), plus keeping the Funnel interim protection from the other "not yet specified" item.
- Build sessions need a decision on domain purchase and a DNS host that can point at the Mac mini, or a Tailscale-side mapping of the custom name. Out of scope for this research.
- Verification design: `verifyToken` with `jwtKey` and `authorizedParties` in a single server middleware, with `sub` as user id. Local mode bypasses it.

## Sources

- https://clerk.com/docs/guides/sessions/manual-jwt-verification
- https://clerk.com/docs/reference/backend/verify-token
- https://clerk.com/docs/reference/backend/authenticate-request
- https://clerk.com/docs/guides/sessions/session-tokens
- https://clerk.com/docs/guides/how-clerk-works/overview
- https://clerk.com/docs/guides/development/managing-environments
- https://clerk.com/docs/guides/development/deployment/production
- https://clerk.com/docs/guides/development/troubleshooting/using-production-keys-in-development
- https://clerk.com/docs/guides/development/errors/frontend-api
- https://clerk.com/docs/guides/development/clerk-environment-variables
- https://clerk.com/docs/react/reference/components/clerk-provider
- https://clerk.com/docs/guides/dashboard/dns-domains/subdomain-allowlist
- https://clerk.com/docs/guides/dashboard/dns-domains/satellite-domains
- https://clerk.com/docs/guides/dashboard/dns-domains/proxy-fapi
- https://clerk.com/pricing
