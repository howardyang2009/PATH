import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { apiClient } from "./api.js";
import { App } from "./app.js";
import "./tokens.css";
import "./designer.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("missing #root element");

// The file to open is a deep-link query param — `/designer/?path=<relative/path.workflow.json>`. Omitted,
// the canvas shows its empty affordance, whose "Open workflow" picker (#254) opens any discovered file; the
// toolbar's "Open…" does the same once a file is open. The deep-link stays the shareable entry point.
const initialPath = new URLSearchParams(window.location.search).get("path") ?? undefined;

createRoot(rootEl).render(
  <StrictMode>
    <App client={apiClient} initialPath={initialPath} />
  </StrictMode>,
);
