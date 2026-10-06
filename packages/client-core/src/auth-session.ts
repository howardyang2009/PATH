import {
  defaultFetch,
  type FetchLike,
  HttpTransport,
  type RequestAuth,
  trimBaseUrl,
} from "./transport.js";

/** `GET /v0/auth-config`: which mode the Server runs in and the key a hosted client signs in with. */
export type AuthConfig =
  | { mode: "local"; publishableKey: null }
  | { mode: "hosted"; publishableKey: string };

/** The `<div>` a Clerk component mounts into, typed loosely: this package builds without the DOM
 * library, and only the lazily loaded Clerk touches the DOM. */
export type MountNode = object;

/** The page's `location`: where sign-out lands, and how the app reloads. */
export interface PageLocation {
  readonly href: string;
  reload(): void;
}

/** The part of a loaded `Clerk` instance the session uses, so tests can stand in for it. */
export interface ClerkLike {
  load(options?: {
    routerPush?: (to: string) => void;
    routerReplace?: (to: string) => void;
    afterSignOutUrl?: string;
  }): Promise<void>;
  readonly user: { id: string } | null | undefined;
  readonly session:
    | { getToken: (options?: { skipCache?: boolean }) => Promise<string | null> }
    | null
    | undefined;
  openSignIn(): void;
  mountUserButton(node: MountNode): void;
  unmountUserButton(node: MountNode): void;
  addListener(listener: (resources: { user?: { id: string } | null }) => void): () => void;
}

/** Who is signed in, and the sign-in actions a surface needs. Local mode has one fixed user. */
export interface AuthSession {
  readonly mode: AuthConfig["mode"];
  /** The signed-in user id: `local` in local mode, null while signed out. */
  userId(): string | null;
  /** Calls `listener` whenever the signed-in user changes. */
  subscribe(listener: () => void): () => void;
  /** The `PathApiClient` options that sign each request; empty in local mode. */
  clientAuth(): Partial<RequestAuth>;
  /** Opens the sign-in modal and settles once a user is signed in. */
  signIn(): Promise<void>;
  /** Mounts Clerk's user menu into `node`; returns the unmount. */
  mountUserButton(node: MountNode): () => void;
}

export interface StartAuthSessionOptions {
  baseUrl: string;
  fetch?: FetchLike;
  /** Loads Clerk for `publishableKey`; only called in hosted mode, so local mode loads no Clerk. */
  loadClerk?: (publishableKey: string) => Promise<ClerkLike>;
  /** The page's `location` (`window.location` in a browser). */
  location: PageLocation;
}

const LOCAL_SESSION: AuthSession = {
  mode: "local",
  userId: () => "local",
  subscribe: () => () => {},
  clientAuth: () => ({}),
  signIn: async () => {},
  mountUserButton: () => () => {},
};

/** Reads the Server's auth config and, in hosted mode only, loads Clerk and its session. */
export async function startAuthSession(options: StartAuthSessionOptions): Promise<AuthSession> {
  const http = new HttpTransport(trimBaseUrl(options.baseUrl), options.fetch ?? defaultFetch);
  const config = await http.requestJson<AuthConfig>("/v0/auth-config");
  if (config.mode !== "hosted") return LOCAL_SESSION;
  const clerk = await (options.loadClerk ?? loadClerkJs)(config.publishableKey);
  return hostedSession(clerk, options.location);
}

async function loadClerkJs(publishableKey: string): Promise<ClerkLike> {
  const { Clerk } = await import("@clerk/clerk-js");
  return new Clerk(publishableKey) as unknown as ClerkLike;
}

async function hostedSession(clerk: ClerkLike, location: PageLocation): Promise<AuthSession> {
  const listeners = new Set<() => void>();
  let pending: { promise: Promise<void>; resolve: () => void } | null = null;

  // Clerk navigates after a modal sign-in; skipping that keeps the screen, and so unsaved edits.
  // After a sign-out it reloads the page, which then shows only the sign-in screen.
  const navigate = (): void => {
    if (!pending) location.reload();
  };
  await clerk.load({
    routerPush: navigate,
    routerReplace: navigate,
    afterSignOutUrl: location.href,
  });

  // A `401` while Clerk still holds a session means its cached token was refused: the retry mints a
  // fresh one, and a second `401` reaches the caller.
  let refreshToken = false;
  const signIn = (): Promise<void> => {
    if (clerk.user) {
      refreshToken = true;
      return Promise.resolve();
    }
    if (!pending) {
      let resolve = (): void => {};
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      pending = { promise, resolve };
    }
    clerk.openSignIn();
    return pending.promise;
  };

  // `pageUserId` is whose data the page holds; `signedInUserId` is null while signed out. A lost
  // session opens no modal here: the next `401` does, after Clerk's own sign-out reload.
  let pageUserId = clerk.user?.id ?? null;
  let signedInUserId = pageUserId;
  clerk.addListener(({ user }) => {
    const id = user?.id ?? null;
    if (id === signedInUserId) return;
    signedInUserId = id;
    if (id !== null) {
      if (pageUserId !== null && id !== pageUserId) return location.reload();
      pageUserId = id;
      pending?.resolve();
      pending = null;
    }
    for (const listener of listeners) listener();
  });

  return {
    mode: "hosted",
    userId: () => signedInUserId,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clientAuth: () => ({
      getToken: async () => {
        const skipCache = refreshToken;
        refreshToken = false;
        return clerk.session ? clerk.session.getToken({ skipCache }) : null;
      },
      onUnauthorized: signIn,
    }),
    signIn,
    mountUserButton: (node) => {
      clerk.mountUserButton(node);
      return () => clerk.unmountUserButton(node);
    },
  };
}
