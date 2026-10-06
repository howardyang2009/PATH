import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { dbFilePath, openProject, type Project } from "@path/engine";
import {
  type AuthoredKind,
  type AuthoredLayout,
  authoredLayout,
  DEFAULT_USER_ID,
} from "./authored-layout.js";
import { createLiveRuns, type LiveRuns } from "./live-runs.js";
import { openSecretStore, type SecretStore, type SecretsKey } from "./secret-store.js";

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
  /** Resolves once every run started in any store held here has settled. */
  idle(): Promise<void>;
  /** Closes every store held here, the project's own included. */
  close(): void;
}

export interface RequesterContextOptions {
  projectDir: string;
  /** A test may point a kind's shipped root elsewhere. */
  shippedDir?: Partial<Record<AuthoredKind, string>>;
  /** The project's own store, opened at boot so a bad settings file or db refuses to start. Every
   * local-mode requester resolves to it; hosted mode never does. */
  projectStore: Project;
  /** Local mode by default: every request acts for `local` (ADR 0090). */
  resolveUserId?: UserIdResolver;
  /** Hosted mode confines each requester's doors and refs to their view (ADR 0088), and keeps
   * each requester's runs and User secrets in their own store at `users/<user-id>/.path/`. */
  hosted?: boolean;
  /** The master key each hosted requester's Secret store is encrypted under. */
  secretsKey?: SecretsKey;
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
  hosted = false,
  secretsKey,
}: RequesterContextOptions): RequesterContexts {
  const contexts = new Map<string, RequesterContext>();
  const projectLive = createLiveRuns(projectStore);

  /** The user's own store, its runs and its User secrets; local mode shares the project's store
   * and has no Secret store. */
  const storeFor = (
    userId: string,
  ): { store: Project; live: LiveRuns; secrets: SecretStore | undefined } => {
    if (!hosted) return { store: projectStore, live: projectLive, secrets: undefined };
    if (secretsKey === undefined) throw new Error("hosted mode has no PATH_SECRETS_KEY");
    const opened = openProject(join(projectDir, "users", userId));
    if (!opened.success) throw new Error(opened.error);
    const store = opened.project;
    const secrets = openSecretStore(dbFilePath(store.dir), secretsKey);
    return { store, live: createLiveRuns(store), secrets };
  };

  const contextFor = (userId: string): RequesterContext => ({
    userId,
    layout: authoredLayout({ projectDir, shippedDir, userId, hosted }),
    ...storeFor(userId),
  });

  if (!hosted) contexts.set(DEFAULT_USER_ID, contextFor(DEFAULT_USER_ID));

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

    async idle() {
      const lives = new Set([projectLive, ...[...contexts.values()].map((c) => c.live)]);
      await Promise.all([...lives].map((live) => live.idle()));
    },

    close() {
      // Local-mode contexts share the project's store; each hosted context owns its own.
      projectStore.close();
      for (const context of contexts.values()) {
        if (context.store !== projectStore) context.store.close();
        context.secrets?.close();
      }
      contexts.clear();
    },
  };
}
