import type { IncomingMessage } from "node:http";
import type { Project } from "@path/engine";
import { type AuthoredKind, type AuthoredLayout, authoredLayout } from "./authored-layout.js";
import type { LiveRuns } from "./live-runs.js";
import type { SecretStore } from "./secret-store.js";
import type { Tenancy } from "./tenancy.js";

/**
 * Who one request acts for (ADR 0088): the user id, the authored layout that user reads through,
 * the store that user's runs live in, the runs executing in that store, and, in hosted mode only,
 * the user's Secret store (ADR 0089).
 */
export interface RequesterContext {
  readonly userId: string;
  readonly layout: AuthoredLayout;
  readonly store: Project;
  readonly live: LiveRuns;
  readonly secrets: SecretStore | undefined;
}

/** One requester context per user, kept across that user's requests. */
export interface RequesterContexts {
  /** The requester `req` acts for, built on first use and reused after; `undefined` when `req`
   * proves no identity. */
  forRequest(req: IncomingMessage): Promise<RequesterContext | undefined>;
  /** Resolves once every run started in any store held here has settled. */
  idle(): Promise<void>;
  /** Closes every store held here, the project's own included. */
  close(): void;
}

export interface RequesterContextOptions {
  projectDir: string;
  /** A test may point a kind's shipped root elsewhere. */
  shippedDir?: Partial<Record<AuthoredKind, string>>;
  /** Who a request acts for, and where that user's runs live. */
  tenancy: Tenancy;
}

/**
 * The requester contexts of one server process, keyed by user id: a request's id is resolved, then
 * that user's layout and store are built once and handed to every later request of theirs.
 */
export function createRequesterContexts({
  projectDir,
  shippedDir,
  tenancy,
}: RequesterContextOptions): RequesterContexts {
  const contexts = new Map<string, RequesterContext>();

  return {
    async forRequest(req) {
      const userId = await tenancy.resolveUserId(req);
      if (userId === undefined) return undefined;
      // No `await` between the read and the write, so concurrent first requests share one context.
      const held = contexts.get(userId);
      if (held !== undefined) return held;
      const context: RequesterContext = {
        userId,
        layout: authoredLayout({ projectDir, shippedDir, userId, hosted: tenancy.hosted }),
        ...tenancy.openUser(userId),
      };
      contexts.set(userId, context);
      return context;
    },

    idle: () => tenancy.idle(),

    close() {
      tenancy.close();
      contexts.clear();
    },
  };
}
