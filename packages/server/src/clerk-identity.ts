import { verifyToken } from "@clerk/backend";
import { firstHeader } from "./origin-gate.js";
import type { UserIdResolver } from "./tenancy.js";

/** A Clerk user id, safe to use as a folder name. `local` never matches. */
const CLERK_USER_ID = /^user_[A-Za-z0-9]+$/;

export interface ClerkIdentityOptions {
  /** The Clerk PEM public key: verification needs no network call. */
  jwtKey: string;
  /** The exact public origin a session token must be issued for. */
  allowedOrigin: string;
}

/**
 * The hosted-mode resolver: the `sub` of the request's verified `Authorization: Bearer` token, or
 * `undefined` when the token is missing, invalid, expired, issued for no or another origin, or
 * names no Clerk user. Every request is verified again, with no cache (ADR 0090 §2).
 */
export function clerkUserIdResolver({
  jwtKey,
  allowedOrigin,
}: ClerkIdentityOptions): UserIdResolver {
  return async (req) => {
    const token = bearerToken(firstHeader(req.headers.authorization));
    if (token === undefined) return undefined;
    let sub: string;
    try {
      ({ sub } = await verifyToken(token, { jwtKey, authorizedParties: [allowedOrigin] }));
    } catch {
      return undefined;
    }
    return CLERK_USER_ID.test(sub) ? sub : undefined;
  };
}

function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  return match?.[1];
}
