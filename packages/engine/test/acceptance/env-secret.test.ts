import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main, type CliIo } from "../../src/cli.js";

/**
 * The reached-when of map #113 (ticket #117): the checked-in
 * `docs/acceptance-workflow/env-secret-probe.workflow.json` running through the real `path run`,
 * proving both sides of the persistence seam for `{"$secret": {"$env": "..."}}`. Why the case is
 * synthetic, what each shape in the workflow is load-bearing for, and the surfaces it does and does
 * not reach are in `docs/acceptance-workflow/env-secret-probe.NOTES.md` — its neighbour
 * `release-notes.test.ts` defers to `NOTES.md` the same way.
 *
 * The one thing worth restating at the assertions themselves: nothing here asserts "the token is
 * absent" alone — that passes just as well for a step that never ran. Every masking assertion is
 * paired with the receipt file, which is what says the real value travelled.
 *
 * Tests mutate `process.env` (the run-start snapshot is `runWorkflow`'s own read of it), so they
 * must stay sequential — vitest's default per-file isolation is what makes that true, and
 * `describe.concurrent` here would break it.
 */

const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const acceptanceDir = join(dirname(dirname(packageRoot)), "docs", "acceptance-workflow");

/**
 * A synthetic credential, never a real one, and deliberately long and distinctive: masking is by
 * value (mvp spec §8.3), so a short or common value would over-replace and make "the artifact does
 * not contain it" pass for the wrong reason.
 */
const TOKEN = "tok-acceptance-9f41c7a2e05b8d63";

/** The second env-sourced value, `{"$env": ...}` with no `$secret` over it — masked by nothing. */
const PROBE_ID = "probe-acceptance-77";

const TOKEN_MASK = "[secret:token]";

const RECEIPT_FILE = "token-receipt.txt";

/** The variables the probe workflow sources, and the only ones this file touches. */
const PROBE_ENV_VARS = ["PATH_ACCEPTANCE_TOKEN", "PATH_ACCEPTANCE_PROBE_ID"] as const;
type ProbeEnvVar = (typeof PROBE_ENV_VARS)[number];

interface Harness {
  projectDir: string;
  io: CliIo;
  stdout: string[];
  stderr: string[];
  /** Memoized so a helper reading a blob path does not reopen the db for every path it builds. */
  rootRunId?: string;
}

let harness: Harness;
let savedEnv: Record<string, string | undefined>;

/** A throwaway project directory holding just the probe workflow — `.path/` is created beside it. */
function createProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "path-env-acceptance-"));
  cpSync(join(acceptanceDir, "env-secret-probe.workflow.json"), join(dir, "env-secret-probe.workflow.json"));
  return dir;
}

/**
 * How the test supplies the variables: on `process.env` of the test process itself, which is the
 * environment `runWorkflow` snapshots at run start (`run-workflow.ts` reads it directly — there is
 * no injection point through `main`). Clears both first, so what a test does not name is *unset*
 * rather than left over from the previous one; `afterEach` restores what was there before, so no
 * later test file inherits either.
 */
function setProbeEnv(values: Partial<Record<ProbeEnvVar, string>>): void {
  for (const name of PROBE_ENV_VARS) delete process.env[name];
  for (const [name, value] of Object.entries(values)) process.env[name] = value;
}

beforeEach(() => {
  savedEnv = Object.fromEntries(PROBE_ENV_VARS.map((name) => [name, process.env[name]]));
  const stdout: string[] = [];
  const stderr: string[] = [];
  harness = {
    projectDir: createProject(),
    stdout,
    stderr,
    io: { log: (m) => stdout.push(m), error: (m) => stderr.push(m) },
  };
  setProbeEnv({ PATH_ACCEPTANCE_TOKEN: TOKEN, PATH_ACCEPTANCE_PROBE_ID: PROBE_ID });
});

afterEach(() => {
  for (const name of PROBE_ENV_VARS) {
    const saved = savedEnv[name];
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
  rmSync(harness.projectDir, { recursive: true, force: true });
});

/** The real `path run`, with no worker or observer substituted. */
function runProbe(extraArgs: string[] = []): Promise<number> {
  return main(["run", join(harness.projectDir, "env-secret-probe.workflow.json"), ...extraArgs], harness.io, {});
}

/** Where the probe writes what it received — outside `.path/`, so the masking sweep never sees it. */
function receiptPath(): string {
  return join(harness.projectDir, RECEIPT_FILE);
}

/** What the child process wrote from its **argv** — see the assertion that reads it. */
function readReceipt(): string {
  return readFileSync(receiptPath(), "utf8");
}

interface RunRow {
  run_id: string;
  parent_run_id: string | null;
  node_id: string | null;
  status: string;
}

function readRuns(): RunRow[] {
  const db = new Database(join(harness.projectDir, ".path", "path.db"), { readonly: true });
  try {
    return db.prepare("SELECT run_id, parent_run_id, node_id, status FROM runs").all() as RunRow[];
  } finally {
    db.close();
  }
}

/** Memoized per test: `blobPath` is called once per artifact, and each miss reopens the db. */
function rootRunId(): string {
  harness.rootRunId ??= readRuns().find((row) => row.parent_run_id === null)!.run_id;
  return harness.rootRunId;
}

/** The db log backend's events, raw, so trace values and error strings are visible. */
function readLogEvents(): Record<string, unknown>[] {
  const db = new Database(join(harness.projectDir, ".path", "path.db"), { readonly: true });
  try {
    const rows = db.prepare("SELECT event FROM log_events ORDER BY seq").all() as { event: string }[];
    return rows.map((row) => JSON.parse(row.event) as Record<string, unknown>);
  } finally {
    db.close();
  }
}

/**
 * The same narrative off the *other* default backend (mvp spec §8.2: sqlite + per-root-run NDJSON,
 * both on). Read separately rather than trusted to agree with the db: masking happens engine-side
 * before either backend sees an event, but "both backends carry the mask" is the claim, and one
 * backend cannot testify for the other. The first line is the NDJSON header (#19), not an event.
 */
function readNdjsonLogEvents(): Record<string, unknown>[] {
  return readFileSync(join(harness.projectDir, ".path", "runs", rootRunId(), "run.log"), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.seq !== undefined);
}

function blobPath(runId: string, name: string): string {
  return join(harness.projectDir, ".path", "runs", rootRunId(), runId, name);
}

function stepRunId(nodeId: string): string {
  return readRuns().find((row) => row.node_id === nodeId)!.run_id;
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
  walk(join(harness.projectDir, ".path"));
  return found;
}

describe("acceptance: $env + $secret composed (map #113 reached-when, ticket #117)", () => {
  it("hands the child process the real value, through interpolation rather than inheritance", async () => {
    const code = await runProbe();

    expect(harness.stderr).toEqual([]);
    expect(code).toBe(0);
    // The probe writes its **argv** to the receipt, never `process.env.PATH_ACCEPTANCE_TOKEN` —
    // the child inherits the whole process environment (`binary-worker.ts`), so reading the
    // variable there would prove nothing about `$env`. Reaching argv means the wrapper resolved,
    // rode inheritance into the step's effective config, and `${config.token}` interpolated to the
    // real credential (mvp spec §8.3: workers get real values; masking is an audit concern).
    expect(readReceipt()).toBe(TOKEN);
  });

  it("leaves the resolved value in no persisted artifact at all", async () => {
    await expect(runProbe()).resolves.toBe(0);
    expect(readReceipt()).toBe(TOKEN); // the value did travel — see above

    // The whole audit surface in one sweep, `path.db` included: run rows, blobs, both log backends.
    // Deliberately not a list of the artifacts this workflow happens to produce — a new blob or a
    // new column that forgets masking is caught here rather than the next time someone updates it.
    const files = everyPersistedFile();
    for (const file of files) {
      expect(readFileSync(file, "utf8"), `secret leaked into ${file}`).not.toContain(TOKEN);
    }
    // The sweep read real content, and it read the places the credential passed through — without
    // this, deleting the workflow's body would satisfy every `not.toContain` above. Named files
    // rather than a count: "at least one file carries the mask" is satisfied by any single blob,
    // which says nothing about the surfaces that matter.
    const stepId = stepRunId("use-token");
    const masked = files.filter((file) => readFileSync(file, "utf8").includes(TOKEN_MASK));
    for (const expected of [
      join(harness.projectDir, ".path", "path.db"), // run rows and the db log backend
      join(harness.projectDir, ".path", "runs", rootRunId(), "run.log"), // the ndjson log backend
      blobPath(stepId, "input.json"),
      blobPath(stepId, "output.json"),
      blobPath(stepId, "stderr.txt"),
      blobPath(rootRunId(), "context.json"),
    ]) {
      expect(masked, `no mask reached ${expected}`).toContain(expected);
    }
  });

  it("writes [secret:token] into each artifact the seam covers", async () => {
    await expect(runProbe()).resolves.toBe(0);
    const stepId = stepRunId("use-token");

    // Input object blob: the step's interpolated input, as it crossed into persistence.
    expect(JSON.parse(readFileSync(blobPath(stepId, "input.json"), "utf8"))).toEqual({
      token: TOKEN_MASK,
      probe_id: PROBE_ID,
    });
    // Output object blob: the child echoed the credential back on stdout.
    expect(JSON.parse(readFileSync(blobPath(stepId, "output.json"), "utf8"))).toBe(TOKEN_MASK);
    // Captured stderr, which is where a real client would print a rejected credential.
    const stderrBlob = readFileSync(blobPath(stepId, "stderr.txt"), "utf8");
    expect(stderrBlob).toContain(TOKEN_MASK);
    // context.json write-through: `publish` put the echoed value on the run's blackboard.
    expect(JSON.parse(readFileSync(blobPath(rootRunId(), "context.json"), "utf8"))).toMatchObject({
      echoed: TOKEN_MASK,
    });
  });

  it("masks the condition trace, which reads the secret out of context", async () => {
    await expect(runProbe()).resolves.toBe(0);

    // A checkpoint's trace records the value each leaf actually read (mvp spec §8.1, "post-masking").
    // `token-round-tripped` reads `context.echoed`, so this is the log-event path that carries a
    // secret payload — the ordinary lifecycle events have theirs stripped.
    for (const events of [readLogEvents(), readNdjsonLogEvents()]) {
      const checkpoint = events.find((event) => event.type === "checkpoint-passed");
      expect(checkpoint).toBeDefined();
      expect(checkpoint!.trace).toMatchObject({ path: "context.echoed", outcome: "true", value: TOKEN_MASK });
    }
    // The predicate ran against the *real* value: `^[A-Za-z0-9._-]+$` passes for the token and
    // fails for a `{"$env": ...}` wrapper serialized in its place, so a passing checkpoint is
    // itself evidence that resolution happened before the condition read it.
  });

  it("does not mask an env-sourced value the author did not mark secret", async () => {
    await expect(runProbe()).resolves.toBe(0);

    // `probe_id` is `{"$env": ...}` with no `$secret` over it. Masking is by value and the author
    // says which sourced values are secret (format §8.3) — "env is always secret" was rejected on
    // map #113 precisely so an env-sourced model name is not scrubbed out of every artifact.
    expect(readFileSync(blobPath(stepRunId("use-token"), "stderr.txt"), "utf8")).toContain(PROBE_ID);
    expect(JSON.parse(harness.stdout.join("\n"))).toEqual({ probe_id: PROBE_ID });
  });

  it("masks the error string of a step that failed with the secret on its stderr", async () => {
    // A non-zero exit puts the tail of stderr — credential and all — into the step's error, which
    // reaches the log stream. The one artifact class the happy path cannot reach.
    //
    // The surface is the `step-finished` **log event**, not a run row: `runs` (persistence/db.ts)
    // has `status` and no error column, and `finishRun` writes only status and finished_at. §8.3
    // used to say "run-row error strings", which named nothing that exists; #124 corrected it to
    // this event. Whether the row should carry an error at all is §10's deferred register now.
    const code = await runProbe(["--set", "exit_code=3"]);

    expect(code).toBe(1);
    expect(readReceipt()).toBe(TOKEN); // the child still got the real value before failing

    for (const events of [readLogEvents(), readNdjsonLogEvents()]) {
      const failures = events.filter((event) => event.type === "step-finished" && event.status === "failed");
      expect(failures.length).toBeGreaterThan(0);
      for (const event of failures) {
        expect(event.error).toContain(TOKEN_MASK);
        expect(event.error).not.toContain(TOKEN);
      }
    }
    for (const file of everyPersistedFile()) {
      expect(readFileSync(file, "utf8"), `secret leaked into ${file}`).not.toContain(TOKEN);
    }
  });

  it("prints the *masked* error on the CLI's own stderr — the operator's terminal, and CI's log", async () => {
    await expect(runProbe(["--set", "exit_code=3"])).resolves.toBe(1);

    // This assertion used to pin the opposite, as the seam's stated edge (#117). #123 settled it:
    // the CLI's stderr is an audit surface, because under `$env` the operator is often a secret
    // store rather than a person and the terminal is often a retained CI build log. So
    // `RunResult.error` is masked at the run's return — the one field beyond the persistence
    // boundary that is. Its counterweight, `RunResult.output` staying real, needs a workflow whose
    // output map *is* a secret; this probe's is `probe_id`, so it is pinned where a file can be
    // shaped for it: `run-workflow.test.ts`, "hands the worker the real secret…".
    const printed = harness.stderr.join("\n");
    expect(printed).toContain("run failed:");
    expect(printed).toContain(TOKEN_MASK);
    expect(printed).not.toContain(TOKEN);
  });
});

describe("acceptance: an unset variable refuses the run (ticket #117)", () => {
  it("fails before the first step and names the missing variable", async () => {
    setProbeEnv({ PATH_ACCEPTANCE_PROBE_ID: PROBE_ID });

    const code = await runProbe();

    expect(code).toBe(1);
    const message = harness.stderr.join("\n");
    expect(message).toContain("run failed before its first step");
    expect(message).toContain("PATH_ACCEPTANCE_TOKEN");
    expect(message).toContain('config key "token"');
    // Before step 1, not at step 1: the child never spawned, so there is no receipt. Asserted on
    // the file's absence rather than on `readReceipt()` throwing — that would be satisfied by a
    // typo in the path just as well as by a step that never ran.
    expect(existsSync(receiptPath())).toBe(false);

    // The run is still on the record — it started, and ended failed (format §8.3).
    const runs = readRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.parent_run_id).toBeNull();
    expect(runs[0]!.status).toBe("failed");

    // And *why* it failed is on the record too, in the log stream: the root run's `run-finished`
    // narrates as a failed `step-finished` carrying the message. Pinned on both backends because
    // the run row cannot hold it — it has status and no error column (#124), which is the whole of
    // what §8.3 means by the error being persisted in the log stream alone.
    for (const events of [readLogEvents(), readNdjsonLogEvents()]) {
      const failed = events.filter((event) => event.type === "step-finished" && event.status === "failed");
      expect(failed).toHaveLength(1);
      expect(failed[0]!.error).toContain("PATH_ACCEPTANCE_TOKEN");
      expect(failed[0]!.error).toContain('config key "token"');
    }
  });

  it("names every missing variable in one failure, not just the first", async () => {
    setProbeEnv({});

    await expect(runProbe()).resolves.toBe(1);

    const message = harness.stderr.join("\n");
    expect(message).toContain("2 environment variables are not set");
    expect(message).toContain("PATH_ACCEPTANCE_TOKEN");
    expect(message).toContain("PATH_ACCEPTANCE_PROBE_ID");
  });
});
