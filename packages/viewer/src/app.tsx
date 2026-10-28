import type { PathApiClient, UserMenuItem } from "@path/client-core";
import { useTranslations } from "use-intl";
import { AppShell, TopBar } from "./app-shell.js";
import { useAuthMode } from "./auth-gate.js";
import { LaunchPanel } from "./launch-panel.js";
import { NodeIo } from "./node-io.js";
import { RunDetail } from "./run-detail.js";
import { RunsList } from "./runs-list.js";
import { SecretsPage } from "./secrets-page.js";
import { useViewerPage, viewerPath } from "./viewer-page.js";
import { useWatchedRun, useWatchedRunReading } from "./watched-run.js";

/**
 * The viewer app: the runs console, and in hosted mode the Secrets page at `/viewer/secrets`,
 * reached from the user menu. Local mode has no Secrets page, so that URL shows the console.
 */
export function App({ client }: { client: PathApiClient }) {
  const t = useTranslations("viewer");
  const hosted = useAuthMode() === "hosted";
  const { page, go } = useViewerPage();
  const menuItems: UserMenuItem[] = hosted
    ? [{ label: t("secretsPage.title"), icon: "\u{1F511}", onClick: () => go("secrets") }]
    : [];
  if (!hosted || page !== "secrets") return <RunsConsole client={client} menuItems={menuItems} />;
  return (
    <div className="shell">
      <TopBar sub={t("app.subSecrets")} menuItems={menuItems} />
      <main className="secrets-main">
        <a
          className="secrets-back"
          href={viewerPath("console")}
          onClick={(event) => {
            event.preventDefault();
            go("console");
          }}
        >
          {t("app.backToRuns")}
        </a>
        <SecretsPage client={client} />
      </main>
    </div>
  );
}

/**
 * The runs console: the pinned three-pane console with the runs list, run detail and node I/O panes.
 * Both selections are owned here, and so is the watched run's connection — the centre and right
 * panes are two views of one live snapshot, and a second connection would mean a second SSE stream.
 *
 * A status-filter change in the runs list does not clear the selection: what is selected is a root
 * run id, not a visible row, so narrowing the list is no reason to stop watching.
 */
function RunsConsole({ client, menuItems }: { client: PathApiClient; menuItems: UserMenuItem[] }) {
  const t = useTranslations("viewer.app");
  // The watched root run, the selected node run and the list's reload nudge: one selection the
  // Viewer shares with the Designer's dock (use-run-selection.ts).
  // The watched root run, the selected node run and the list's reload nudge, over one connection:
  // the watched run the Viewer shares with the Designer's dock (watched-run.ts).
  const watch = useWatchedRun(client);
  const { selection, load } = watch;
  const selectedRootRunId = selection.rootRunId;
  const { runFiles, rootFile, selectedRun } = useWatchedRunReading(client, watch);

  const handleLaunched = selection.watchNewRun;

  return (
    <AppShell
      menuItems={menuItems}
      workflows={<LaunchPanel client={client} onLaunched={handleLaunched} />}
      runs={
        <RunsList
          client={client}
          watch={watch}
          // The `Resume from …` action reads the watched run's root file so the eager legal-K
          // check greys the button like the Designer's; the Viewer never edits.
          rootFile={rootFile}
        />
      }
      detail={
        selectedRootRunId === null ? (
          <p className="pane-note">{t("selectRun")}</p>
        ) : (
          <RunDetail client={client} watch={watch} runFiles={runFiles} />
        )
      }
      nodeIo={
        selectedRun === undefined ? (
          <p className="pane-note">{t("selectTreeRun")}</p>
        ) : (
          <NodeIo
            client={client}
            run={selectedRun}
            // One snapshot feeds the pane: it reads this run's display status and error off the
            // view (ADR 0025).
            view={load.phase === "ready" ? load.value : undefined}
            runFiles={runFiles}
          />
        )
      }
    />
  );
}
