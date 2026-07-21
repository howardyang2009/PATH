const USAGE = "usage: path-server [project-dir] [--port <n>]";

export interface ParsedServerArgs {
  projectDir: string;
  port: number;
}

export type ParseServerArgsResult = { success: true; args: ParsedServerArgs } | { success: false; error: string };

/** `project-dir` defaults to cwd; `--port` defaults to 0 (an OS-assigned ephemeral port). */
export function parseServerArgs(argv: string[], cwd: string = process.cwd()): ParseServerArgsResult {
  let projectDir: string | undefined;
  let port = 0;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--port") {
      const value = argv[i + 1];
      const parsed = Number(value);
      if (!value || !Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
        return { success: false, error: `--port requires an integer between 0 and 65535\n${USAGE}` };
      }
      port = parsed;
      i += 1;
    } else if (projectDir === undefined) {
      projectDir = arg;
    } else {
      return { success: false, error: `unrecognized argument "${arg}"\n${USAGE}` };
    }
  }

  return { success: true, args: { projectDir: projectDir ?? cwd, port } };
}
