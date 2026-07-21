/**
 * §5 acceptance run for ticket #39 — drives the release-notes pipeline entirely through
 * `@path/server` and reports each of the four spec §5 criteria.
 *
 * Human-led: this spends real LLM tokens. Run it against a real git repo checkout that contains the
 * acceptance workflow files (`release-notes.workflow.json` + `revise-cycle.workflow.json`) at its
 * root, with your Agent SDK credentials in the environment.
 *
 *   ANTHROPIC_API_KEY=... npx tsx scripts/acceptance-release-notes.mts /path/to/repo
 *
 * The project dir defaults to the current directory. Exits non-zero if any criterion fails.
 */
import { startPathServer } from "../src/create-server.js";
import { runAcceptance } from "../src/acceptance/run-acceptance.js";

const projectDir = process.argv[2] ?? process.cwd();

const handle = await startPathServer(projectDir);
console.error(`path-server listening on ${handle.url} (project: ${projectDir})`);
console.error("driving release-notes.workflow.json through the server — this spends tokens…\n");

try {
  const report = await runAcceptance({
    url: handle.url,
    projectDir,
    workflowPath: "release-notes.workflow.json",
  });

  for (const c of report.criteria) {
    console.log(`[${c.pass ? "PASS" : "FAIL"}] §5.${c.id}  ${c.title}`);
    console.log(`         ${c.detail}`);
  }
  console.log(`\nroot_run_id: ${report.rootRunId ?? "—"}   status: ${report.status ?? "—"}`);
  console.log(report.passed ? "\nALL FOUR §5 CRITERIA PASSED ✓" : "\nSOME §5 CRITERIA FAILED ✗");
  process.exitCode = report.passed ? 0 : 1;
} finally {
  await handle.close();
}
