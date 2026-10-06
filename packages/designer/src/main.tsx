import { mountApp } from "@path/viewer";
import { App } from "./app.js";
// The Viewer's `tokens.css` is the one shared token sheet, so it loads first; the Designer's own
// sheet adds only the per-kind block hues, and `designer.css` loads last so its frame classes win.
import "@path/viewer/tokens.css";
import "@path/viewer/viewer.css";
import "./tokens.css";
import "./designer.css";

// `?path=` deep-links the file to open; omitted, the canvas shows its empty affordance.
const initialPath = new URLSearchParams(window.location.search).get("path") ?? undefined;

mountApp((client) => <App client={client} initialPath={initialPath} />);
