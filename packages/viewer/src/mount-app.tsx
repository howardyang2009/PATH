import { type AuthSession, PathApiClient, startAuthSession } from "@path/client-core";
import { type ReactNode, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AuthGate } from "./auth-gate.js";

/** Renders an app into `#root` behind the sign-in gate. Its API client uses same-origin relative
 * URLs (`/v0/...`), which the Vite proxy forwards in dev and `path-server` serves in prod. */
export function mountApp(app: (client: PathApiClient) => ReactNode): void {
  const rootEl = document.getElementById("root");
  if (!rootEl) throw new Error("missing #root element");
  const root = createRoot(rootEl);
  const render = (auth?: AuthSession): void => {
    const client = new PathApiClient({ baseUrl: "", ...auth?.clientAuth() });
    root.render(
      <StrictMode>
        {auth ? <AuthGate auth={auth}>{app(client)}</AuthGate> : app(client)}
      </StrictMode>,
    );
  };

  // An unreadable auth config renders the app as local mode does, so its panes show the Server's
  // own errors; a hosted Server still refuses every unsigned call.
  startAuthSession({ baseUrl: "", location: window.location }).then(render, (error: unknown) => {
    console.error("cannot start sign-in", error);
    render();
  });
}
