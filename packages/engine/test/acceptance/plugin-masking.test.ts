import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import type { WorkflowFile } from "@path/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogBackends } from "../../src/logging/backends.js";
import { createLoggingObserver } from "../../src/logging/logging-observer.js";
import { openDb } from "../../src/persistence/db.js";
import { createPersistedObserver } from "../../src/persistence/persisted-observer.js";
import { dbFilePath, RUN_BLOB_FILE, runBlobDir } from "../../src/persistence/paths.js";
import { composeObservers } from "../../src/run-observer.js";
import { runWorkflow } from "../../src/run-workflow.js";

/**
 * The acceptance test ADR 0020 sub-decision 10 declares part of the decision (ticket #338): a fixture
 * step-type plugin returns a config `$secret` in all three of its `StepResult` channels — `output`,
 * `stderr`, `usage` — and the end-to-end run masks every one of them on disk. It mirrors
 * `test/acceptance/env-secret.test.ts`: a real run, a whole-audit-surface sweep, and every masking
 * assertion paired with a receipt that says the real value actually travelled.
 *
 * What it proves that `env-secret` does not: masking is inherited *by a plugin*, not just by the
 * built-in `binary` type. The `echo-secret` fixture (`test/fixtures/masking-plugin/echo-secret/`) is a
 * plugin the engine never special-cased — a third-party-shaped folder — reached through the *scanned*
 * registry and real dispatch (`RunOptions.stepPluginsDir` points the folder scan at the fixture dir).
 * Its worker does nothing to mask its own return; masking is inherited by construction at the engine's
 * one emit choke point (sub-decision 1), so the leak surfaces here if that choke point ever misses a
 * plugin's `output`, `stderr`, or `usage`.
 *
 * Scope (from the issue): the sanctioned return path only. A runtime-minted secret and anything a
 * worker writes straight to a process stream are the two documented limits of ADR 0020, not covered.
 */

/**
 * A synthetic credential, never a real one, deliberately long and distinctive: masking is by value
 * (mvp spec §8.3), so a short or common value would over-replace and make "the artifact does not
 * contain it" pass for the wrong reason.
 */
const SECRET = "sk-plugin-mask-8b2f4c1e7a90d63f";
const SECRET_MASK = "[secret:secret]";

/** The scanned location for this run: the fixture parent holding the one `echo-secret/` folder. */
const FIXTURE_PLUGINS_DIR = fileURLToPath(new URL("../fixtures/masking-plugin/", import.meta.url));

let projectDir: string;
let db: Database.Database;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "path-plugin-mask-"));
  db = openDb(dbFilePath(projectDir));
});

afterEach(() => {
  db.close();
  rmSync(projectDir, { recursive: true, force: true });
});

/**
 * The workflow file: `config.secret` is a `$secret`, inherited to the single `echo-secret` leaf. The
 * `WorkflowFile` type is the *built-in* union, so a plugin `type` is not assignable at compile time —
 * a plugin folder contributes its own type only at run time (CONTEXT: validity is registry-relative).
 * The `unknown` cast is the same seam every plugin leaf crosses; the scan is what makes it valid.
 */
function workflowFile(): WorkflowFile {
  return {
    format: "path/workflow@3",
    id: "00000000-0000-4000-8000-0000000000aa",
    name: "plugin-masking",
    config: { secret: { $secret: SECRET } },
    body: [
      {
        type: "echo-secret",
        id: "11111111-1111-4111-8111-1111111111aa",
        name: "echo",
        publish: { echoed: "${output.echoed}" },
      },
    ],
    output: { result: "${context.echoed}" },
  } as unknown as WorkflowFile;
}

/** Both default backends of a real run (mvp spec §8.2): sqlite rows + blobs, and the db/ndjson log. */
function persistingObserver() {
  const backends = createLogBackends(["db", "ndjson"], { db, projectDir });
  return composeObservers(createPersistedObserver(db, projectDir), createLoggingObserver(backends));
}

function run() {
  return runWorkflow(workflowFile(), projectDir, {
    observer: persistingObserver(),
    stepPluginsDir: FIXTURE_PLUGINS_DIR,
  });
}

interface RunRow {
  run_id: string;
  parent_run_id: string | null;
  node_name: string | null;
  usage: string | null;
}

function readRuns(): RunRow[] {
  return db.prepare("SELECT run_id, parent_run_id, node_name, usage FROM runs").all() as RunRow[];
}

function rootRunId(): string {
  return readRuns().find((row) => row.parent_run_id === null)!.run_id;
}

function stepRun(nodeName: string): RunRow {
  return readRuns().find((row) => row.node_name === nodeName)!;
}

function blobPath(runId: string, name: string): string {
  return join(runBlobDir(projectDir, rootRunId(), runId), name);
}

/** Every file under `.path/`, so a leak can be looked for across the whole audit surface at once. */
function everyPersistedFile(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else found.push(full);
    }
  };
  walk(join(projectDir, ".path"));
  return found;
}

describe("acceptance: a plugin inherits masking on its return path (ADR 0020 sub-10, #338)", () => {
  it("runs the fixture plugin through the scanned registry and returns the real product", async () => {
    const result = await run();

    // The run reached the scanned `echo-secret` worker and ran it: a succeeded run's `output` is the
    // *product*, returned real (mvp spec §8.3). So this is the receipt that the worker saw and echoed
    // the real credential — without it, every "not.toContain" below would pass for a run that never ran.
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({ result: SECRET });
  });

  it("leaves the resolved secret in no persisted artifact at all", async () => {
    await run();

    // The whole audit surface in one sweep, `path.db` included — run rows (the `usage` column among
    // them), blobs, and both log backends. Deliberately not a list of the artifacts this run happens
    // to produce, so a new blob or column that forgets masking is caught here.
    const files = everyPersistedFile();
    for (const file of files) {
      expect(readFileSync(file, "utf8"), `secret leaked into ${file}`).not.toContain(SECRET);
    }

    // The sweep read real content and read the places the secret passed through — without this,
    // emptying the workflow body would satisfy every `not.toContain` above. Named the artifacts that
    // matter rather than a count: "some blob carries the mask" is met by any single file.
    const step = stepRun("echo");
    const masked = files.filter((file) => readFileSync(file, "utf8").includes(SECRET_MASK));
    for (const expected of [
      join(projectDir, ".path", "path.db"), // run rows (incl. the usage column) and the db log backend
      blobPath(step.run_id, RUN_BLOB_FILE.output),
      blobPath(step.run_id, RUN_BLOB_FILE.stderr),
      blobPath(rootRunId(), RUN_BLOB_FILE.context),
    ]) {
      expect(masked, `no mask reached ${expected}`).toContain(expected);
    }
  });

  it("masks the plugin's output, stderr, and usage — its three StepResult channels", async () => {
    await run();
    const step = stepRun("echo");

    // step-finished → output.json: the worker's `output`, masked at the choke point.
    expect(JSON.parse(readFileSync(blobPath(step.run_id, RUN_BLOB_FILE.output), "utf8"))).toEqual({
      echoed: SECRET_MASK,
    });
    // step-stderr → stderr.txt: the worker's returned diagnostic text, masked.
    expect(readFileSync(blobPath(step.run_id, RUN_BLOB_FILE.stderr), "utf8")).toContain(SECRET_MASK);
    // step-usage → the run row's `usage` column: the worker's own report, masked (numbers untouched).
    expect(JSON.parse(step.usage!)).toEqual({ note: `spent on ${SECRET_MASK}`, tokens: 1 });
  });
});
