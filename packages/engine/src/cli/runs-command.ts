import { RUN_STATUSES, type RunStatus } from "@path/schema";
import { type ListRootsOptions, openRunArchive, type RunArchive } from "../run-archive.js";
import { formatRunsTable, type RunsTableRow } from "../run-report.js";
import { extractDirFlag, parsePositiveInt, takeValue } from "./args.js";
import type { CliIo } from "./io.js";

// How many root-run ids `prune` prints before collapsing the rest to "... and N more".
const PRUNE_ID_PREVIEW = 20;

export const RUNS_USAGE =
  "usage: path runs [-C <dir>] [--limit <n>] [--status <status>] [--workflow <name>] [--workflow-id <guid>] | path runs [-C <dir>] rm [--force] <root-run-id> | path runs [-C <dir>] prune [--yes]";

type ListRootsArgsResult =
  | { success: true; options: ListRootsOptions }
  | { success: false; error: string };

// The bare `path runs` listing reuses `listRoots`' `--limit`/`--status` filters, `--status`
// validated against the domain's own set so an unknown status is refused rather than silently
// matching nothing.
function parseRunsListArgs(args: string[]): ListRootsArgsResult {
  let limit: number | undefined;
  let status: RunStatus | undefined;
  let workflowName: string | undefined;
  let workflowId: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === "--limit") {
      const parsed = parsePositiveInt("--limit", args[i + 1], RUNS_USAGE);
      if (!parsed.success) return parsed;
      limit = parsed.value;
      i += 1;
    } else if (flag === "--status") {
      const value = args[i + 1];
      if (!value || !RUN_STATUSES.includes(value as RunStatus)) {
        return {
          success: false,
          error: `--status requires one of ${RUN_STATUSES.join(", ")}\n${RUNS_USAGE}`,
        };
      }
      status = value as RunStatus;
      i += 1;
    } else if (flag === "--workflow") {
      // Exact match on the source workflow's human `name` — the display key in this table.
      const taken = takeValue(args, i, "--workflow", "a name", RUNS_USAGE);
      if (!taken.success) return taken;
      workflowName = taken.value;
      i += 1;
    } else if (flag === "--workflow-id") {
      // Exact match on the durable GUID — unambiguous where two files share a `name`.
      const taken = takeValue(args, i, "--workflow-id", "a guid", RUNS_USAGE);
      if (!taken.success) return taken;
      workflowId = taken.value;
      i += 1;
    } else {
      return { success: false, error: `unrecognized argument "${flag}"\n${RUNS_USAGE}` };
    }
  }

  return { success: true, options: { limit, status, workflowName, workflowId } };
}

// `path runs` with no subcommand: the first listing surface, over the same query `rm`/`prune`
// operate on. The `resumed-from` cell asks which predecessor ids still have rows, not which are on
// this page.
async function runRunsListCommand(args: string[], dir: string, io: CliIo): Promise<number> {
  const parsed = parseRunsListArgs(args);
  if (!parsed.success) {
    io.error(parsed.error);
    return 2;
  }

  return withRunArchive(dir, io, (archive) => {
    const roots = archive.listRoots(parsed.options);
    const predecessorIds = roots
      .map((run) => run.resumedFromRootRunId)
      .filter((id): id is string => id !== null);
    const live = archive.existingRunIds(predecessorIds);

    const rows = roots.map((run): RunsTableRow => {
      const predecessor = run.resumedFromRootRunId;
      const resumedFrom =
        predecessor === null
          ? "-"
          : live.has(predecessor)
            ? predecessor
            : `${predecessor} (deleted)`;
      // The human `name` is the display key; "-" is the defensive floor for a row with no recorded
      // identity.
      return [
        run.runId,
        run.workflowName ?? "-",
        archive.displayStatus(run),
        run.startedAt ?? "-",
        run.finishedAt ?? "-",
        resumedFrom,
      ];
    });

    io.log(formatRunsTable(rows));
    return 0;
  });
}

/** Open the run archive under `dir`, hand it to `use`, and close it however `use` ends; a failed
 * open exits 1. */
async function withRunArchive(
  dir: string,
  io: CliIo,
  use: (archive: RunArchive) => number | Promise<number>,
): Promise<number> {
  const opened = openRunArchive(dir);
  if (!opened.success) {
    io.error(opened.error);
    return 1;
  }
  try {
    return await use(opened.archive);
  } finally {
    opened.close();
  }
}

// `runs rm`/`runs prune` take no workflow-file argument: they operate on the `.path/` in the cwd,
// or on `-C <dir>` when given one.
export async function runRunsCommand(args: string[], io: CliIo): Promise<number> {
  const dirFlag = extractDirFlag(args, RUNS_USAGE);
  if (!dirFlag.success) {
    io.error(dirFlag.error);
    return 2;
  }
  const dir = dirFlag.dir ?? process.cwd();
  const [subcommand, ...rest] = dirFlag.rest;

  if (subcommand === "rm") {
    // `--force` overrides the live-reuse-marker block; splitting flags from operands keeps the
    // "exactly one id" check counting ids, not the flag.
    const force = rest.includes("--force");
    const unknownFlag = rest.find((arg) => arg.startsWith("--") && arg !== "--force");
    if (unknownFlag !== undefined) {
      io.error(`unknown flag "${unknownFlag}"\n${RUNS_USAGE}`);
      return 2;
    }
    const operands = rest.filter((arg) => !arg.startsWith("--"));
    const rootRunId = operands[0];
    if (!rootRunId) {
      io.error(RUNS_USAGE);
      return 2;
    }
    // One id, not a list: a second operand is refused rather than silently dropped.
    if (operands.length > 1) {
      io.error(`runs rm takes exactly one run id, got ${operands.length}\n${RUNS_USAGE}`);
      return 2;
    }

    return withRunArchive(dir, io, (archive) => {
      // The guard reads before deleting: a live successor reusing this tree's data blocks the
      // delete unless `--force`; a not-found id has no blockers and falls through to `remove`'s own
      // error.
      const blockers = archive.blockingSuccessors(rootRunId);
      if (blockers.length > 0 && !force) {
        io.error(
          `refusing to remove ${rootRunId}: live successor run(s) reuse its data: ${blockers.join(", ")}\n` +
            `re-run with --force to delete it anyway — those successors would keep a dangling reference`,
        );
        return 1;
      }
      // "Found" means either store held something: an orphaned directory with no rows still counts,
      // so `rm` finishes a half-done cleanup rather than reporting "not found" while deleting it
      // anyway.
      if (!archive.remove(rootRunId)) {
        io.error(`no run found with id "${rootRunId}"`);
        return 1;
      }
      io.log(`removed run ${rootRunId}`);
      // `--force` deletes exactly the named tree, no cascade, so the successors it orphaned are
      // named here or the dangling reference stays invisible.
      if (blockers.length > 0) {
        io.log(`orphaned successor run(s): ${blockers.join(", ")}`);
      }
      return 0;
    });
  }

  if (subcommand === "prune") {
    // `prune` takes no operands: a destructive verb must be at least as strict about its input as
    // `run` is. `--yes`/`-y` skip the confirmation prompt for scripted use.
    const yes = rest.includes("--yes") || rest.includes("-y");
    const badArg = rest.find((arg) => arg !== "--yes" && arg !== "-y");
    if (badArg !== undefined) {
      io.error(`runs prune takes no arguments, got "${badArg}"\n${RUNS_USAGE}`);
      return 2;
    }

    return withRunArchive(dir, io, async (archive) => {
      // Confirm before deleting: a bare `prune` wipes every root. `--yes` skips the gate; an empty
      // project prunes unprompted. `listRoots` defaults to a 50-row page, so pass an unbounded
      // limit.
      const roots = archive.listRoots({ limit: Number.MAX_SAFE_INTEGER });
      if (!yes && roots.length > 0) {
        // Cap the printed ids so thousands of roots do not bury the prompt; the count is the true
        // total.
        const shown = roots.slice(0, PRUNE_ID_PREVIEW);
        const more = roots.length - shown.length;
        io.log(
          `prune will permanently delete all ${roots.length} root run(s) and cannot be undone:\n` +
            shown.map((root) => `  ${root.runId}`).join("\n") +
            (more > 0 ? `\n  ... and ${more} more` : "") +
            `\npass --yes to skip this prompt.`,
        );
        const confirmed = await io.confirm?.("delete them? [y/N]");
        if (!confirmed) {
          io.error("aborted: nothing was removed");
          return 1;
        }
      }
      const deleted = archive.prune();
      io.log(`pruned ${deleted} run(s)`);
      return 0;
    });
  }

  // No subcommand, or a leading flag, is the bare listing; any other word earns the usage error.
  if (subcommand === undefined || subcommand.startsWith("--")) {
    return runRunsListCommand(dirFlag.rest, dir, io);
  }

  io.error(RUNS_USAGE);
  return 2;
}
