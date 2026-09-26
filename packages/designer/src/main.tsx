import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { apiClient } from "./api.js";
import { App } from "./app.js";
// The reused run panels read Viewer-only vars from the Viewer's `tokens.css`, so it loads first; the
// Designer's own palette and stylesheet load last and so win the shared vars.
import "@path/viewer/tokens.css";
import "@path/viewer/viewer.css";
import "./tokens.css";
import "./designer.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("missing #root element");

// `?path=` deep-links the file to open; omitted, the canvas shows its empty affordance.
const initialPath = new URLSearchParams(window.location.search).get("path") ?? undefined;

createRoot(rootEl).render(
  <StrictMode>
    <App client={apiClient} initialPath={initialPath} />
  </StrictMode>,
);
