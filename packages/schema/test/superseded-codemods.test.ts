import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SUPERSEDED_FORMAT_VERSIONS } from "../src/workflow-file-type.js";

/**
 * The "run the codemod" message is a fix, so every script it names must exist. The chains live in
 * `workflow-file-type.ts` while the scripts live in `scripts/`; a format bump that forgets to add its
 * codemod, or a move that renames one, turns the message into a path the operator cannot run.
 */
const repoRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

describe("SUPERSEDED_FORMAT_VERSIONS", () => {
  it("every codemod a superseded format names exists on disk", () => {
    const missing = Object.entries(SUPERSEDED_FORMAT_VERSIONS).flatMap(([format, codemods]) =>
      codemods
        .filter((codemod) => !existsSync(join(repoRoot, codemod)))
        .map((codemod) => `${format} names ${codemod}, which does not exist`),
    );
    expect(missing).toEqual([]);
  });
});
