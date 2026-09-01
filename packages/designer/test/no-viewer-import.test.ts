import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Every file under the Designer's `src/`, recursively. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? sourceFiles(full) : [full];
  });
}

describe("Designer isolation (#372 / ADR 0028)", () => {
  it("never imports @path/viewer", () => {
    // Vitest runs with the package root as cwd, so `src` resolves there.
    const srcDir = join(process.cwd(), "src");
    // Only real module specifiers count — a prose mention of the package in a comment (e.g. tokens.css
    // documenting the ADR-0028 boundary) is not an import.
    const specifier = /(?:import|export)[^;]*?from\s*["']@path\/viewer|import\(\s*["']@path\/viewer/;
    const offenders = sourceFiles(srcDir)
      .filter((file) => /\.tsx?$/.test(file))
      .filter((file) => specifier.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });
});
