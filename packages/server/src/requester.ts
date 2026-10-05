import type { IncomingMessage } from "node:http";
import type { Project } from "@path/engine";
import {
  type AuthoredKind,
  type AuthoredLayout,
  authoredLayout,
  DEFAULT_USER_ID,
} from "./authored-layout.js";

/**
 * Who one request acts for (ADR 0088): the user id, the authored layout that user reads through,
 * and the store that user's runs live in.
 */
export interface RequesterContext {
  readonly userId: string;
  readonly layout: AuthoredLayout;
  readonly store: Project;
}

/**
 * The user id one request acts for, or `undefined` when the request proves no identity. Local mode
 * answers `local` for every request; hosted mode verifies the bearer token here instead (ADR 0090).
 */
export type UserIdResolver = (
  req: IncomingMessage,
) => string | undefined | Promise<string | undefined>;

/** One requester context per user, kept across that user's requests. */
export interface RequesterContexts {
  /** The requester `req` acts for, built on first use and reused after; `undefined` when `req`
   * proves no identity. */
  forRequest(req: IncomingMessage): Promise<RequesterContext | undefined>;
  /** Closes every store held here, the project's own included. */
  close(): void;
}

export interface RequesterContextOptions {
  projectDir: string;
  /** A test may point a kind's shipped root elsewhere. */
  shippedDir?: Partial<Record<AuthoredKind, string>>;
  /** The project's own store, opened at boot so a bad settings file or db refuses to start. Every
   * requester resolves to it until hosted mode gives each user a store of their own. */
  projectStore: Project;
  /** Local mode by default: every request acts for `local` (ADR 0090). */
  resolveUserId?: UserIdResolver;
}

/**
 * The requester contexts of one server process, keyed by user id: a request's id is resolved, then
 * that user's layout and store are built once and handed to every later request of theirs.
 */
export function createRequesterContexts({
  projectDir,
  shippedDir,
  projectStore,
  resolveUserId = () => DEFAULT_USER_ID,
}: RequesterContextOptions): RequesterContexts {
  const contexts = new Map<string, RequesterContext>();

  const contextFor = (userId: string): RequesterContext => ({
    userId,
    layout: authoredLayout({ projectDir, shippedDir, userId }),
    store: projectStore,
  });

  contexts.set(DEFAULT_USER_ID, contextFor(DEFAULT_USER_ID));

  return {
    async forRequest(req) {
      const userId = await resolveUserId(req);
      if (userId === undefined) return undefined;
      // No `await` between the read and the write, so concurrent first requests share one context.
      const held = contexts.get(userId);
      if (held !== undefined) return held;
      const context = contextFor(userId);
      contexts.set(userId, context);
      return context;
    },

    close() {
      // A store can serve more than one context, so identity decides what to close.
      const closed = new Set<Project>();
      for (const context of contexts.values()) {
        if (closed.has(context.store)) continue;
        closed.add(context.store);
        context.store.close();
      }
      contexts.clear();
    },
  };
}
