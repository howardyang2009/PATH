import { describe, expect, it } from "vitest";
import { type ClerkLike, startAuthSession } from "../src/auth-session.js";
import type { FetchLike } from "../src/transport.js";

type Listener = Parameters<ClerkLike["addListener"]>[0];

/** A stand-in for Clerk: a user that tests sign in and out, and a count of opened sign-in modals. */
class FakeClerk implements ClerkLike {
  user: { id: string } | null;
  session: { getToken: (options?: { skipCache?: boolean }) => Promise<string | null> } | null;
  /** How many tokens were minted bypassing Clerk's token cache. */
  freshTokens = 0;
  signInModals = 0;
  loaded = false;
  private readonly listeners = new Set<Listener>();

  constructor(userId: string | null) {
    this.user = null;
    this.session = null;
    this.setUser(userId);
  }

  loadOptions: Parameters<ClerkLike["load"]>[0];

  async load(options: Parameters<ClerkLike["load"]>[0]): Promise<void> {
    this.loaded = true;
    this.loadOptions = options;
  }

  /** Clerk's own navigation after a sign-in or sign-out, through the router it was given. */
  navigate(to: string): void {
    this.loadOptions?.routerPush?.(to);
  }

  openSignIn(): void {
    this.signInModals += 1;
  }

  mountUserButton(): void {}
  unmountUserButton(): void {}

  addListener(listener: Listener): () => void {
    this.listeners.add(listener);
    listener({ user: this.user });
    return () => this.listeners.delete(listener);
  }

  /** Sign in as `id`, or sign out with null, and tell every listener. */
  setUser(id: string | null): void {
    this.user = id === null ? null : { id };
    this.session =
      id === null
        ? null
        : {
            getToken: async (options) => {
              if (options?.skipCache) this.freshTokens += 1;
              return `token-of-${id}`;
            },
          };
    for (const listener of this.listeners) listener({ user: this.user });
  }
}

function configFetch(body: unknown): { fetch: FetchLike; urls: string[] } {
  const urls: string[] = [];
  const fetch: FetchLike = async (url) => {
    urls.push(url);
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { fetch, urls };
}

function fakeLocation(reloads: { count: number } = { count: 0 }) {
  return {
    href: "http://h/designer/",
    reload: () => {
      reloads.count += 1;
    },
  };
}

const hosted = { mode: "hosted", publishableKey: "pk_test_abc" };

async function startHosted(clerk: FakeClerk, reloads: { count: number } = { count: 0 }) {
  const keys: string[] = [];
  const session = await startAuthSession({
    baseUrl: "http://h",
    fetch: configFetch(hosted).fetch,
    loadClerk: async (key) => {
      keys.push(key);
      return clerk;
    },
    location: fakeLocation(reloads),
  });
  return { session, keys };
}

describe("startAuthSession", () => {
  it("in local mode reads auth-config and never loads Clerk", async () => {
    const stub = configFetch({ mode: "local", publishableKey: null });
    let loads = 0;
    const session = await startAuthSession({
      baseUrl: "http://h",
      fetch: stub.fetch,
      location: fakeLocation(),
      loadClerk: async () => {
        loads += 1;
        return new FakeClerk(null);
      },
    });

    expect(stub.urls).toEqual(["http://h/v0/auth-config"]);
    expect(loads).toBe(0);
    expect(session.mode).toBe("local");
    expect(session.userId()).toBe("local");
    expect(session.clientAuth()).toEqual({});
  });

  it("in hosted mode loads Clerk with the publishable key", async () => {
    const clerk = new FakeClerk("user_1");
    const { session, keys } = await startHosted(clerk);

    expect(keys).toEqual(["pk_test_abc"]);
    expect(clerk.loaded).toBe(true);
    expect(session.mode).toBe("hosted");
    expect(session.userId()).toBe("user_1");
    await expect(session.clientAuth().getToken?.()).resolves.toBe("token-of-user_1");
  });

  it("with no session has no user and no token", async () => {
    const { session } = await startHosted(new FakeClerk(null));

    expect(session.userId()).toBeNull();
    await expect(session.clientAuth().getToken?.()).resolves.toBeNull();
  });

  it("signIn opens the modal and settles once a user signs in", async () => {
    const clerk = new FakeClerk(null);
    const { session } = await startHosted(clerk);
    let notified = 0;
    session.subscribe(() => {
      notified += 1;
    });

    let settled = false;
    const signedIn = session.signIn().then(() => {
      settled = true;
    });
    expect(clerk.signInModals).toBe(1);
    await Promise.resolve();
    expect(settled).toBe(false);

    clerk.setUser("user_1");
    await signedIn;
    expect(session.userId()).toBe("user_1");
    expect(notified).toBeGreaterThan(0);
  });

  it("concurrent 401s while signed out all settle on one sign-in", async () => {
    const clerk = new FakeClerk("user_1");
    const { session } = await startHosted(clerk);
    clerk.setUser(null);

    const onUnauthorized = session.clientAuth().onUnauthorized;
    const settled: string[] = [];
    const first = onUnauthorized?.().then(() => settled.push("first"));
    const second = onUnauthorized?.().then(() => settled.push("second"));
    await Promise.resolve();
    expect(settled).toEqual([]);

    clerk.setUser("user_1");
    await Promise.all([first, second]);
    expect(settled).toEqual(["first", "second"]);
  });

  it("a 401 while Clerk still holds a session retries at once with a fresh token", async () => {
    const clerk = new FakeClerk("user_1");
    const { session } = await startHosted(clerk);

    const auth = session.clientAuth();
    await auth.getToken?.();
    expect(clerk.freshTokens).toBe(0);

    await auth.onUnauthorized?.();
    await auth.getToken?.();
    expect(clerk.signInModals).toBe(0);
    expect(clerk.freshTokens).toBe(1);

    await auth.getToken?.();
    expect(clerk.freshTokens).toBe(1);
  });

  it("signing out reloads the page, so only the sign-in screen shows", async () => {
    const clerk = new FakeClerk("user_1");
    const reloads = { count: 0 };
    await startHosted(clerk, reloads);

    // Clerk tells listeners first, then navigates to the after-sign-out URL.
    clerk.setUser(null);
    clerk.navigate("http://h/designer/");
    expect(reloads.count).toBe(1);
    expect(clerk.signInModals).toBe(0);
  });

  it("the navigation after a modal sign-in is skipped, so the screen and its edits stay", async () => {
    const clerk = new FakeClerk("user_1");
    const reloads = { count: 0 };
    const { session } = await startHosted(clerk, reloads);
    clerk.setUser(null);

    const signedIn = session.clientAuth().onUnauthorized?.();
    clerk.navigate("http://h/designer/");
    clerk.setUser("user_1");
    await signedIn;
    expect(reloads.count).toBe(0);
  });

  it("a different user signing in reloads the app", async () => {
    const clerk = new FakeClerk("user_1");
    const reloads = { count: 0 };
    await startHosted(clerk, reloads);

    clerk.setUser(null);
    clerk.setUser("user_2");
    expect(reloads.count).toBe(1);
  });

  it("the first sign-in from the sign-in screen does not reload", async () => {
    const clerk = new FakeClerk(null);
    const reloads = { count: 0 };
    const { session } = await startHosted(clerk, reloads);

    const signedIn = session.signIn();
    clerk.setUser("user_1");
    await signedIn;
    expect(reloads.count).toBe(0);
  });

  it("refuses an unreadable auth-config", async () => {
    const fetch: FetchLike = async () => new Response("down", { status: 502 });
    await expect(
      startAuthSession({ baseUrl: "http://h", fetch, location: fakeLocation() }),
    ).rejects.toMatchObject({
      status: 502,
    });
  });
});
