import type { IncomingMessage } from "node:http";
import { dbFilePath, openProject, type Project } from "@path/engine";
import { DEFAULT_USER_ID } from "./authored-layout.js";
import { userDir } from "./host-layout.js";
import { createLiveRuns, type LiveRuns } from "./live-runs.js";
import {
  createSandboxedRuns,
  type RunOwner,
  type SandboxOptions,
} from "./sandbox/sandboxed-runs.js";
import { openSecretStore, type SecretStore, type SecretsKey } from "./secret-store.js";

// Tenancy: how a server process maps requests to users and where each user's runs live. Local mode
// has one user on the project's own store with in-process runs; hosted mode verifies each request
// and gives each user their own store, Secret store and VM runs (ADR 0088 to ADR 0091).

/**
 * The user id one request acts for, or `undefined` when the request proves no identity. Local mode
 * answers `local` for every request; hosted mode verifies the bearer token here instead (ADR 0090).
 */
export type UserIdResolver = (
  req: IncomingMessage,
) => string | undefined | Promise<string | undefined>;

/** One user's store, the runs executing in it, and their Secret store. */
export interface UserStore {
  readonly store: Project;
  readonly live: LiveRuns;
  readonly secrets: SecretStore | undefined;
}

export interface Tenancy {
  /** Hosted mode confines each requester's doors and refs to their view (ADR 0088). */
  readonly hosted: boolean;
  /** The user id one request acts for, or `undefined` when it proves no identity. */
  readonly resolveUserId: UserIdResolver;
  /** Opens `userId`'s store; the requester contexts call it once per user. */
  openUser(userId: string): UserStore;
  /** Resolves once every run outside the per-user stores has settled. */
  idle(): Promise<void>;
  /** Closes the boot store and every user store this tenancy opened. */
  close(): void;
}

/** Local mode: every request acts for `local`, on the project's store, with in-process runs. */
export function localTenancy(
  projectStore: Project,
  resolveUserId: UserIdResolver = () => DEFAULT_USER_ID,
): Tenancy {
  const shared: UserStore = {
    store: projectStore,
    live: createLiveRuns(projectStore),
    secrets: undefined,
  };
  return {
    hosted: false,
    resolveUserId,
    openUser: () => shared,
    idle: () => shared.live.idle(),
    close: () => projectStore.close(),
  };
}

export interface HostedTenancyOptions {
  projectDir: string;
  /** The project's own store, opened at boot; no hosted requester runs in it. */
  projectStore: Project;
  resolveUserId: UserIdResolver;
  /** The master key each user's Secret store is encrypted under. */
  secretsKey: SecretsKey;
  /** The key a rotation moves rows off; rows under it still read until they move. */
  previousSecretsKey?: SecretsKey;
  sandbox: SandboxOptions;
  /** What each user's VMs are held to. */
  runOwner: (userId: string) => RunOwner;
}

/** Hosted mode: each user's runs and User secrets live in their own store at
 * `users/<user-id>/.path/`, and every run executes in a VM (ADR 0091). */
export function hostedTenancy(options: HostedTenancyOptions): Tenancy {
  const { projectDir, projectStore, sandbox, runOwner } = options;
  const opened: UserStore[] = [];
  return {
    hosted: true,
    resolveUserId: options.resolveUserId,
    openUser(userId) {
      const result = openProject(userDir(projectDir, userId));
      if (!result.success) throw new Error(result.error);
      const store = result.project;
      const user: UserStore = {
        store,
        live: createSandboxedRuns(store, sandbox, runOwner(userId)),
        secrets: openSecretStore(
          dbFilePath(store.dir),
          options.secretsKey,
          options.previousSecretsKey,
        ),
      };
      opened.push(user);
      return user;
    },
    idle: async () => {
      await Promise.all(opened.map((user) => user.live.idle()));
    },
    close() {
      projectStore.close();
      for (const user of opened) {
        user.store.close();
        user.secrets?.close();
      }
      opened.length = 0;
    },
  };
}
