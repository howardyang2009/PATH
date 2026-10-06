import { PathApiClient, startAuthSession } from "@path/client-core";
import { type ReactNode, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AuthGate } from "./auth-gate.js";
import { errorMessage } from "./load-state.js";

/** Renders an app into `#root` behind the sign-in gate. Its API client uses same-origin relative
 * URLs (`/v0/...`), which the Vite proxy forwards in dev and `path-server` serves in prod. */
export function mountApp(app: (client: PathApiClient) => ReactNode): void {
  const rootEl = document.getElementById("root");
  if (!rootEl) throw new Error("missing #root element");
  const root = createRoot(rootEl);

  startAuthSession({ baseUrl: "", location: window.location }).then(
    (auth) => {
      const client = new PathApiClient({ baseUrl: "", ...auth.clientAuth() });
      root.render(
        <StrictMode>
          <AuthGate auth={auth}>{app(client)}</AuthGate>
        </StrictMode>,
      );
    },
    (error: unknown) =>
      root.render(
        <p role="alert" className="boot-error">
          Cannot start sign-in: {errorMessage(error)}
        </p>,
      ),
  );
}
