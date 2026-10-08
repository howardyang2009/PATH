import type { AuthSession } from "@path/client-core";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AuthGate, UserMenu } from "../src/auth-gate.js";

/** A hosted session a test signs in and out by hand. */
function fakeHosted(userId: string | null) {
  let current = userId;
  const listeners = new Set<() => void>();
  const mounted: object[] = [];
  let signIns = 0;
  const session: AuthSession = {
    mode: "hosted",
    userId: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clientAuth: () => ({}),
    signIn: async () => {
      signIns += 1;
    },
    mountUserButton: (node) => {
      mounted.push(node);
      return () => mounted.splice(mounted.indexOf(node), 1);
    },
  };
  return {
    session,
    mounted,
    signIns: () => signIns,
    setUser(id: string | null) {
      current = id;
      act(() => {
        for (const listener of listeners) listener();
      });
    },
  };
}

const localSession: AuthSession = {
  mode: "local",
  userId: () => "local",
  subscribe: () => () => {},
  clientAuth: () => ({}),
  signIn: async () => {},
  mountUserButton: () => () => {},
};

function renderApp(session: AuthSession) {
  return render(
    <AuthGate auth={session}>
      <header>
        <UserMenu />
      </header>
      <p>the app</p>
    </AuthGate>,
  );
}

describe("AuthGate", () => {
  it("in local mode shows the app with no user menu", () => {
    renderApp(localSession);

    expect(screen.getByText("the app")).toBeInTheDocument();
    expect(screen.queryByTestId("user-menu")).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });

  it("in hosted mode with no session shows only the sign-in screen and opens the modal", () => {
    const fake = fakeHosted(null);
    renderApp(fake.session);

    expect(screen.queryByText("the app")).toBeNull();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(fake.signIns()).toBeGreaterThan(0);

    const before = fake.signIns();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(fake.signIns()).toBe(before + 1);
  });

  it("shows the app and the user menu once a user signs in", () => {
    const fake = fakeHosted(null);
    renderApp(fake.session);

    fake.setUser("user_1");
    expect(screen.getByText("the app")).toBeInTheDocument();
    expect(screen.getByTestId("user-menu")).toBeInTheDocument();
    expect(fake.mounted).toHaveLength(1);
  });

  it("mounts Clerk inside the user-menu wrapper, so the wrapper keeps its class", () => {
    const fake = fakeHosted("user_1");
    renderApp(fake.session);

    const wrapper = screen.getByTestId("user-menu");
    expect(fake.mounted[0]).not.toBe(wrapper);
    expect(wrapper.contains(fake.mounted[0] as Node)).toBe(true);
  });

  it("keeps the app on screen when the session is lost mid-use", () => {
    const fake = fakeHosted("user_1");
    renderApp(fake.session);

    fake.setUser(null);
    expect(screen.getByText("the app")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });

  it("outside a gate the user menu renders nothing", () => {
    render(<UserMenu />);
    expect(screen.queryByTestId("user-menu")).toBeNull();
  });
});
