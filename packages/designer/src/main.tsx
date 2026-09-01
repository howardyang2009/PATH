import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { apiClient } from "./api.js";
import { App } from "./app.js";
import "./tokens.css";
import "./designer.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("missing #root element");

// The file to open is a deep-link query param — `/designer/?path=<relative/path.workflow.json>` — until a
// file-picker surface lands in a later #254 ticket. Omitted, the canvas shows its empty affordance.
const initialPath = new URLSearchParams(window.location.search).get("path") ?? undefined;

createRoot(rootEl).render(
  <StrictMode>
    <App client={apiClient} initialPath={initialPath} />
  </StrictMode>,
);
