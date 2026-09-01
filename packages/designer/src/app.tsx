import { AppShell } from "./app-shell.js";
import { Canvas } from "./canvas.js";
import { Palette } from "./palette.js";

/**
 * The Designer app: the tracer bullet for map #254 (#366). It renders the pinned shell with the
 * palette shell in the left rail and an empty canvas at the centre. No open, save, or run yet — those
 * surfaces graduate in later tickets. This is the authoring peer of `@path/viewer`, built on the same
 * `@path/client-core`, and it never imports the Viewer (ADR 0028).
 */
export function App() {
  return <AppShell palette={<Palette />} canvas={<Canvas />} />;
}
