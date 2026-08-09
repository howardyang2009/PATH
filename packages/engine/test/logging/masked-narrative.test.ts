import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfigValue, WorkflowFile } from "@path/schema";
import { describe, expect, it } from "vitest";
import { createLogBackends } from "../../src/logging/backends.js";
import { getLogEventsForRoot } from "../../src/logging/db-backend.js";
import { createLoggingObserver } from "../../src/logging/logging-observer.js";
import { openDb } from "../../src/persistence/db.js";
import { dbFilePath } from "../../src/persistence/paths.js";
import { createPersistedObserver } from "../../src/persistence/persisted-observer.js";
import { getRunsForRoot, type RunRecord } from "../../src/persistence/run-store.js";
import { composeObservers } from "../../src/run-observer.js";
import { runWorkflow } from "../../src/run-workflow.js";
import { stampNames } from "../stamp-names.js";
import { createScriptedLlmWorker, SCRIPTED_COST_USD, SCRIPTED_USAGE } from "../acceptance/scripted-llm-worker.js";

/**
 * The regression test for #62, shaped as a **differential**: every fixture runs twice, identical but
 * for whether its `token` config value is a plain string or a `{"$secret": ...}` wrapper, and the two
 * runs must produce the same narrative and the same populated run-row columns.
 *
 * Why this shape. The defect was not a wrong value — it was *absence*. `createMaskingObserver`
 * implemented 6 of `RunObserver`'s 14 hooks, and merely declaring a secret was enough to route every
 * observation through it, so eight kinds of observation silently disappeared: no checkpoint, branch,
 * loop, join or cancellation events reached either backend, and no run row got `usage`. A test that
 * only checked the secret was masked would have passed throughout. What catches absence is
 * demanding that a secret change *nothing* except the values.
 *
 * Between them the fixtures below emit all eight of the observations that were being dropped.
 */

const SECRET = "s3cret-token-value";
const PLAIN = "plain-token-value";

/** Echo `${config.token}` to stdout, so the secret genuinely reaches an output object and a blob. */
function echoToken(id: string): WorkflowFile["body"][number] {
  return {
    type: "binary",
    id,
    name: id,
    command: "node",
    args: ["-e", "process.stdout.write(process.argv[1])", "${config.token}"],
  };
}

// ── The fixtures. Four of the eight dropped observations had no coverage before this file:
//    step-usage, join-applied, run-cancelled and branch-no-match.

/** checkpoint-evaluated, branch-taken, context-changed. */
const controls: WorkflowFile = {
  format: "path/workflow@1",
  id: "wf-id",
  name: "controls",
  worker: { type: "engine" },
  body: [
    {
      type: "binary",
      id: "seed", name: "seed",
      command: "node",
      args: ["-e", "process.stdout.write(process.argv[1])", "${config.token}"],
      publish: { pick: "b" },
    },
    { type: "checkpoint", id: "gate", name: "gate", condition: { type: "exists", path: "context.pick" } },
    {
      type: "branch",
      id: "route", name: "route",
      arms: [
        { when: { type: "equals", path: "context.pick", value: "b" }, body: [echoToken("arm-b")] },
      ],
      else: [echoToken("fallback")],
    },
  ],
};

/** iteration-started, loop-exited. */
const loop: WorkflowFile = {
  format: "path/workflow@1",
  id: "wf-id",
  name: "loop",
  worker: { type: "engine" },
  body: [
    {
      type: "binary",
      id: "seed", name: "seed",
      command: "node",
      args: ["-e", "process.stdout.write('0')"],
      parse: "json",
      publish: { count: "${output}" },
    },
    {
      type: "while-do",
      id: "spin", name: "spin",
      condition: { type: "range", path: "context.count", max: 1 },
      max_iterations: 4,
      body: [
        {
          type: "binary",
          id: "bump", name: "bump",
          command: "node",
          args: ["-e", "process.stdout.write(String(Number(process.argv[1]) + 1))", "${context.count}"],
          parse: "json",
          publish: { count: "${output}" },
        },
      ],
    },
  ],
};

/** join-applied — every branch succeeds, so the collect join applies at block end. */
const parallelJoin: WorkflowFile = {
  format: "path/workflow@1",
  id: "wf-id",
  name: "parallel-join",
  worker: { type: "engine" },
  body: [
    {
      type: "parallel",
      id: "fan", name: "fan",
      join: "collect",
      branches: [
        {
          id: "left", name: "left",
          body: [
            {
              type: "binary",
              id: "l", name: "l",
              command: "node",
              args: ["-e", "process.stdout.write(process.argv[1])", "${config.token}"],
              publish: { left: "${output}" },
            },
          ],
        },
        {
          id: "right", name: "right",
          body: [
            {
              type: "binary",
              id: "r", name: "r",
              command: "node",
              args: ["-e", "process.stdout.write('r')"],
              publish: { right: "${output}" },
            },
          ],
        },
      ],
    },
  ],
};

/** run-cancelled with cause `sibling-failed` — one branch fails, its in-flight sibling is killed. */
const parallelCancel: WorkflowFile = {
  format: "path/workflow@1",
  id: "wf-id",
  name: "parallel-cancel",
  worker: { type: "engine" },
  body: [
    {
      type: "parallel",
      id: "fan", name: "fan",
      join: "collect",
      branches: [
        {
          id: "doomed", name: "doomed",
          body: [{ type: "binary", id: "kaboom", name: "kaboom", command: "node", args: ["-e", "process.exit(3)"] }],
        },
        {
          id: "victim", name: "victim",
          body: [{ type: "binary", id: "sleeper", name: "sleeper", command: "node", args: ["-e", "setTimeout(() => {}, 5000)"] }],
        },
      ],
    },
  ],
};

/** branch-no-match — no arm matches and there is no `else`, which fails the run (§5.2). */
const noMatch: WorkflowFile = {
  format: "path/workflow@1",
  id: "wf-id",
  name: "branch-no-match",
  worker: { type: "engine" },
  body: [
    {
      type: "binary",
      id: "seed", name: "seed",
      command: "node",
      args: ["-e", "process.stdout.write(process.argv[1])", "${config.token}"],
      publish: { pick: "${output}" },
    },
    {
      type: "branch",
      id: "route", name: "route",
      arms: [{ when: { type: "equals", path: "context.pick", value: "never-matches" }, body: [echoToken("dead")] }],
    },
  ],
};

/** step-usage — the prompt step is where tokens are spent, on the scripted worker. */
const prompt: WorkflowFile = {
  format: "path/workflow@1",
  id: "wf-id",
  name: "prompt-usage",
  worker: { type: "llm", model: "test-model" },
  body: [{ type: "prompt", id: "ask", name: "ask", prompt: "Say hi. ${config.token}" }],
};

interface RunOutcomeSnapshot {
  eventTypes: string[];
  /** Per row: the shape that must not change, never the values that legitimately do. */
  rowShape: { status: string; hasInput: boolean; hasOutput: boolean; hasUsage: boolean; cost: number | null }[];
  usage: (unknown | null)[];
  status: string;
  serialized: string;
}

async function runOnce(file: WorkflowFile, token: ConfigValue): Promise<RunOutcomeSnapshot> {
  const dir = mkdtempSync(join(tmpdir(), "path-engine-masked-narrative-run-"));
  const runDb = openDb(dbFilePath(dir));
  try {
    const backends = createLogBackends(["db", "ndjson"], { db: runDb, projectDir: dir });
    const observer = composeObservers(createPersistedObserver(runDb, dir), createLoggingObserver(backends));
    const llmWorker = createScriptedLlmWorker({ ask: () => "hello" });

    const result = await runWorkflow(stampNames({ ...file, config: { token } }), dir, { observer, llmWorker });

    const rootRunId = (
      runDb.prepare("SELECT DISTINCT root_run_id FROM log_events").get() as { root_run_id: string }
    ).root_run_id;
    const events = getLogEventsForRoot(runDb, rootRunId);
    const rows: RunRecord[] = getRunsForRoot(runDb, rootRunId);

    return {
      status: result.status,
      eventTypes: events.map((e) => e.type),
      rowShape: rows.map((r) => ({
        status: r.status,
        hasInput: r.inputRef !== null,
        hasOutput: r.outputRef !== null,
        hasUsage: r.usage !== null,
        cost: r.estimatedCostUsd,
      })),
      usage: rows.map((r) => r.usage),
      serialized: JSON.stringify({ events, rows }),
    };
  } finally {
    runDb.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const FIXTURES: { name: string; file: WorkflowFile; expects: string[] }[] = [
  { name: "controls", file: controls, expects: ["checkpoint-passed", "branch-taken"] },
  { name: "loop", file: loop, expects: ["iteration-started", "loop-exited"] },
  { name: "parallel join", file: parallelJoin, expects: ["join-applied"] },
  { name: "parallel cancellation", file: parallelCancel, expects: ["run-cancelled"] },
  { name: "branch no-match", file: noMatch, expects: ["branch-no-match"] },
  { name: "prompt usage", file: prompt, expects: [] },
];

describe("declaring a secret must not change the narrative (#62)", () => {
  for (const { name, file, expects } of FIXTURES) {
    it(`${name}: the same events and the same run-row shape, with or without a secret`, async () => {
      const plain = await runOnce(file, PLAIN);
      const secret = await runOnce(file, { $secret: SECRET });

      // The heart of it. Under the old masking wrapper the right-hand side lost whole event types.
      expect(secret.eventTypes).toEqual(plain.eventTypes);
      expect(secret.rowShape).toEqual(plain.rowShape);
      expect(secret.status).toBe(plain.status);

      // ...and the events the fixture exists for are actually present in both.
      for (const type of expects) {
        expect(plain.eventTypes, `${name} should emit ${type}`).toContain(type);
        expect(secret.eventTypes, `${name} should still emit ${type} with a secret`).toContain(type);
      }

      expect(secret.serialized).not.toContain(SECRET);
    });
  }

  it("records usage on the prompt step's row whether or not a secret is declared", async () => {
    const plain = await runOnce(prompt, PLAIN);
    const secret = await runOnce(prompt, { $secret: SECRET });

    // `stepUsage` was one of the eight dropped hooks, so with a secret declared every row's `usage`
    // and `estimated_cost_usd` came back null — mvp spec §11 acceptance criterion 4, unmet.
    for (const snapshot of [plain, secret]) {
      const withUsage = snapshot.rowShape.filter((r) => r.hasUsage);
      expect(withUsage).toHaveLength(1); // leaf-only (§5.7)
      expect(withUsage[0]!.cost).toBe(SCRIPTED_COST_USD);
      expect(snapshot.usage.filter((u) => u !== null)).toEqual([SCRIPTED_USAGE]);
    }
  });

  it("masks the value a condition trace recorded, which no run ever did before", async () => {
    const secret = await runOnce(noMatch, { $secret: SECRET });

    // The `branch-no-match` event carries every arm's trace, and each leaf records the value it read
    // — here `context.pick`, which the seed step published straight from `${config.token}`.
    expect(secret.serialized).toContain("branch-no-match");
    expect(secret.serialized).toContain("[secret:token]");
    expect(secret.serialized).not.toContain(SECRET);
  });
});
