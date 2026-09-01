import type { PathApiClient } from "@path/client-core";
import { AppShell } from "./app-shell.js";
import { Canvas } from "./canvas.js";
import { Palette } from "./palette.js";
import { useOpenFile } from "./use-open-file.js";

/**
 * The Designer app: the pinned shell with the palette in the left rail and the node canvas at the
 * centre. This ticket (#367) grows the canvas from the tracer bullet's empty surface into the read-only
 * **open + render** route — it fetches a workflow file (`GET /v0/workflows/file`) and its registry
 * (`GET /v0/step-plugins`), renders the file in the block grammar, and descends across a `workflow`-ref.
 * Editing, the properties pane, save, and run are later tickets. It is the authoring peer of
 * `@path/viewer`, built on the same `@path/client-core`, and it never imports the Viewer (ADR 0028).
 *
 * `initialPath` is the file to open on load — the deep-link `?path=` the browser entry reads. Omitted,
 * the canvas shows its empty affordance.
 */
export function App({ client, initialPath }: { client: PathApiClient; initialPath?: string }): JSX.Element {
  const session = useOpenFile(client, initialPath);
  return <AppShell palette={<Palette />} canvas={<Canvas session={session} />} />;
}
