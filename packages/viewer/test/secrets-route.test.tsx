import type { AuthSession, UserMenuItem } from "@path/client-core";
import { stubClient } from "@path/client-core/test-utils";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { AuthGate } from "../src/auth-gate.js";

/** A signed-in session; it records the items each mounted user menu carries. */
function session(mode: AuthSession["mode"]) {
  const menus: UserMenuItem[][] = [];
  const auth: AuthSession = {
    mode,
    userId: () => (mode === "hosted" ? "user_1" : "local"),
    subscribe: () => () => {},
    clientAuth: () => ({}),
    signIn: async () => {},
    mountUserButton: (_node, items = []) => {
      menus.push(items);
      return () => {};
    },
  };
  return { auth, menus };
}

function renderViewer(mode: AuthSession["mode"]) {
  const { auth, menus } = session(mode);
  render(
    <AuthGate auth={auth}>
      <App client={stubClient()} />
    </AuthGate>,
  );
  return menus;
}

describe("Viewer Secrets page", () => {
  afterEach(() => window.history.replaceState(null, "", "/viewer/"));

  it("opens from the user menu at /viewer/secrets in hosted mode", async () => {
    window.history.replaceState(null, "", "/viewer/");
    const menus = renderViewer("hosted");
    expect(screen.getByRole("region", { name: "Runs" })).toBeInTheDocument();

    const item = menus[0]?.find((entry) => entry.label === "Secrets");
    act(() => item?.onClick());

    expect(window.location.pathname).toBe("/viewer/secrets");
    expect(screen.getByRole("heading", { name: "Secrets" })).toBeInTheDocument();
    expect(await screen.findByText("No secrets yet.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Runs" })).toBeNull();

    fireEvent.click(screen.getByRole("link", { name: "Back to runs" }));
    expect(window.location.pathname).toBe("/viewer/");
    expect(screen.getByRole("region", { name: "Runs" })).toBeInTheDocument();
  });

  it("follows the browser's back button", () => {
    window.history.replaceState(null, "", "/viewer/secrets");
    renderViewer("hosted");
    expect(screen.getByRole("heading", { name: "Secrets" })).toBeInTheDocument();

    act(() => {
      window.history.replaceState(null, "", "/viewer/");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.getByRole("region", { name: "Runs" })).toBeInTheDocument();
  });

  it("does not exist in local mode", () => {
    window.history.replaceState(null, "", "/viewer/secrets");
    const menus = renderViewer("local");

    expect(menus).toEqual([]);
    expect(screen.queryByRole("heading", { name: "Secrets" })).toBeNull();
    expect(screen.getByRole("region", { name: "Runs" })).toBeInTheDocument();
  });
});
