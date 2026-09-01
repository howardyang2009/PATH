import { useState } from "react";
import type { PathApiClient, WireStepPlugin } from "@path/client-core";
import { AppShell } from "./app-shell.js";
import { Canvas } from "./canvas.js";
import { Palette } from "./palette.js";
import { useOpenFile } from "./use-open-file.js";

/**
 * The Designer app: the pinned shell with the palette in the left rail and the node canvas at the
 * centre. #367 grew the canvas into the read-only open + render route; #368 makes it **editable** — the
 * palette arms a kind, the canvas opens only the grammar-legal sockets, and structure edits (add,
 * reorder, delete, replace a single-slot occupant) mutate the open file through the pure `edit-tree`
 * ops. The properties pane, save, and run stay later tickets. It never imports the Viewer (ADR 0028).
 *
 * `initialPath` is the file to open on load — the deep-link `?path=`. Omitted, the canvas shows its
 * empty affordance. The **armed kind** (the palette selection waiting to be placed) lives here, above
 * both the palette that sets it and the canvas that consumes it.
 */
export function App({ client, initialPath }: { client: PathApiClient; initialPath?: string }): JSX.Element {
  const session = useOpenFile(client, initialPath);
  const [armedKind, setArmedKind] = useState<string | null>(null);
  const plugins: WireStepPlugin[] = session.registry.phase === "ready" ? session.registry.plugins : [];

  return (
    <AppShell
      palette={<Palette plugins={plugins} armedKind={armedKind} onArm={setArmedKind} />}
      canvas={<Canvas session={session} plugins={plugins} armedKind={armedKind} onArm={setArmedKind} />}
    />
  );
}
