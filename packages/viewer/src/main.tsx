import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { apiClient } from "./api.js";
import "./tokens.css";
import "./viewer.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("missing #root element");

createRoot(rootEl).render(
  <StrictMode>
    <App client={apiClient} />
  </StrictMode>,
);
