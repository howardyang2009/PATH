import { useEffect, useState } from "react";
import type { PathApiClient, WireStepPlugin } from "@path/client-core";
import { AppShell } from "./app-shell.js";
import { Canvas } from "./canvas.js";
import { Palette } from "./palette.js";
import { PropertiesPane } from "./properties-pane.js";
import { SelectionProvider } from "./selection-context.js";
import { useOpenFile } from "./use-open-file.js";

/**
 * The Designer app: the pinned shell with the palette in the left rail, the node canvas at the centre,
 * and (from #369) the properties pane at the right. The palette arms a kind, the canvas opens only the
 * grammar-legal sockets and commits structure edits, a single-click on a node selects it, and the pane
 * edits the selected node's content (name, id, kind fields, worker) or — on an empty-canvas click — the
 * file's own properties. Save and run stay later tickets. It never imports the Viewer (ADR 0028).
 *
 * `initialPath` is the file to open on load — the deep-link `?path=`. Omitted, the canvas shows its
 * empty affordance. The **armed kind** (the palette selection) and the **selected id** (what the pane
 * edits) both live here, above the canvas and the pane that read them.
 */
export function App({ client, initialPath }: { client: PathApiClient; initialPath?: string }): JSX.Element {
  const session = useOpenFile(client, initialPath);
  const [armedKind, setArmedKind] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const plugins: WireStepPlugin[] = session.registry.phase === "ready" ? session.registry.plugins : [];

  const active = session.frames[session.frames.length - 1];
  const activePath = active?.path;
  const depth = session.frames.length;
  // A new active file (descend, pop, or open) deselects — the previous file's node ids mean nothing here.
  useEffect(() => {
    setSelectedId(null);
  }, [activePath, depth]);

  const openedFile =
    active?.state.phase === "open" && active.state.result.status === "opened" ? active.state.result.file : null;

  return (
    <AppShell
      palette={<Palette plugins={plugins} armedKind={armedKind} onArm={setArmedKind} />}
      canvas={
        <SelectionProvider value={{ selectedId, onSelect: setSelectedId }}>
          <Canvas session={session} plugins={plugins} armedKind={armedKind} onArm={setArmedKind} />
        </SelectionProvider>
      }
      pane={
        openedFile ? (
          <PropertiesPane
            file={openedFile}
            selectedId={selectedId}
            plugins={plugins}
            applyEdit={session.applyEdit}
            onReselect={setSelectedId}
          />
        ) : (
          <div className="pane pane-idle">
            <p className="pane-hint">Open a workflow and select a node to edit it.</p>
          </div>
        )
      }
    />
  );
}
