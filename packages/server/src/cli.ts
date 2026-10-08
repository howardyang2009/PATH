import type { RemapPair } from "./remap-user.js";

const USAGE = "usage: path-server [project-dir] [--port <n>]";

export interface ParsedServerArgs {
  projectDir: string;
  port: number;
}

export type ParseServerArgsResult =
  | { success: true; args: ParsedServerArgs }
  | { success: false; error: string };

/** `project-dir` defaults to cwd; `--port` defaults to 0 (an OS-assigned ephemeral port). */
export function parseServerArgs(
  argv: string[],
  cwd: string = process.cwd(),
): ParseServerArgsResult {
  let projectDir: string | undefined;
  let port = 0;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--port") {
      const value = argv[i + 1];
      const parsed = Number(value);
      if (!value || !Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
        return {
          success: false,
          error: `--port requires an integer between 0 and 65535\n${USAGE}`,
        };
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

const REMOVE_SHARED_USAGE =
  "usage: path-server remove-shared <path> --reason <text> [--purge] [--find-copies] [--project <dir>]";

export interface ParsedRemoveSharedArgs {
  projectDir: string;
  path: string;
  reason: string;
  purge: boolean;
  findCopies: boolean;
}

export type ParseRemoveSharedArgsResult =
  | { success: true; args: ParsedRemoveSharedArgs }
  | { success: false; error: string };

/** `--project` defaults to cwd; `--reason` is required, since the removal log records it. */
export function parseRemoveSharedArgs(
  argv: string[],
  cwd: string = process.cwd(),
): ParseRemoveSharedArgsResult {
  let path: string | undefined;
  let reason: string | undefined;
  let projectDir = cwd;
  let purge = false;
  let findCopies = false;
  const fail = (error: string) => ({
    success: false as const,
    error: `${error}\n${REMOVE_SHARED_USAGE}`,
  });

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--reason" || arg === "--project") {
      const value = argv[i + 1];
      if (!value) return fail(`${arg} requires a value`);
      if (arg === "--reason") reason = value;
      else projectDir = value;
      i += 1;
    } else if (arg === "--purge") {
      purge = true;
    } else if (arg === "--find-copies") {
      findCopies = true;
    } else if (path === undefined) {
      path = arg;
    } else {
      return fail(`unrecognized argument "${arg}"`);
    }
  }

  if (path === undefined) return fail("missing the shared item's path");
  if (reason === undefined) return fail("--reason is required");
  return { success: true, args: { projectDir, path, reason, purge, findCopies } };
}

const BACKUP_USAGE =
  "usage: path-server backup --out <dir> [--project <dir>]\n       path-server backup verify [--snapshot <dir>]";

export type ParsedBackupArgs =
  | { command: "take"; projectDir: string; outDir: string }
  | { command: "verify"; snapshotDir: string | undefined };

export type ParseBackupArgsResult =
  | { success: true; args: ParsedBackupArgs }
  | { success: false; error: string };

/** `--project` defaults to cwd; `verify` without `--snapshot` restores the latest restic snapshot. */
export function parseBackupArgs(
  argv: string[],
  cwd: string = process.cwd(),
): ParseBackupArgsResult {
  const verify = argv[0] === "verify";
  const flags = verify ? ["--snapshot"] : ["--out", "--project"];
  const values: Record<string, string> = {};
  const fail = (error: string) => ({ success: false as const, error: `${error}\n${BACKUP_USAGE}` });

  for (let i = verify ? 1 : 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (!flags.includes(arg)) return fail(`unrecognized argument "${arg}"`);
    const value = argv[i + 1];
    if (!value) return fail(`${arg} requires a value`);
    values[arg] = value;
    i += 1;
  }

  if (verify)
    return { success: true, args: { command: "verify", snapshotDir: values["--snapshot"] } };
  const outDir = values["--out"];
  if (outDir === undefined) return fail("--out is required");
  return {
    success: true,
    args: { command: "take", projectDir: values["--project"] ?? cwd, outDir },
  };
}

const ROTATE_SECRETS_KEY_USAGE = "usage: path-server rotate-secrets-key [--project <dir>]";

export type ParseRotateSecretsKeyArgsResult =
  | { success: true; args: { projectDir: string } }
  | { success: false; error: string };

/** `--project` defaults to cwd; both keys come from the environment, never from argv. */
export function parseRotateSecretsKeyArgs(
  argv: string[],
  cwd: string = process.cwd(),
): ParseRotateSecretsKeyArgsResult {
  let projectDir = cwd;
  const fail = (error: string) => ({
    success: false as const,
    error: `${error}\n${ROTATE_SECRETS_KEY_USAGE}`,
  });
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg !== "--project") return fail(`unrecognized argument "${arg}"`);
    const value = argv[i + 1];
    if (!value) return fail(`${arg} requires a value`);
    projectDir = value;
    i += 1;
  }
  return { success: true, args: { projectDir } };
}

const REMAP_USER_USAGE =
  "usage: path-server remap-user (<old>=<new>... | --from-clerk) [--dry-run] [--delete-source] [--project <dir>]";

export interface ParsedRemapUserArgs {
  projectDir: string;
  pairs: RemapPair[];
  /** Read the pairs from the Clerk instance's `external_id` values instead. */
  fromClerk: boolean;
  dryRun: boolean;
  deleteSource: boolean;
}

export type ParseRemapUserArgsResult =
  | { success: true; args: ParsedRemapUserArgs }
  | { success: false; error: string };

/** `--project` defaults to cwd; the pairs come from the arguments or from Clerk, not both. */
export function parseRemapUserArgs(
  argv: string[],
  cwd: string = process.cwd(),
): ParseRemapUserArgsResult {
  const args: ParsedRemapUserArgs = {
    projectDir: cwd,
    pairs: [],
    fromClerk: false,
    dryRun: false,
    deleteSource: false,
  };
  const fail = (error: string) => ({
    success: false as const,
    error: `${error}\n${REMAP_USER_USAGE}`,
  });
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--project") {
      const value = argv[i + 1];
      if (!value) return fail(`${arg} requires a value`);
      args.projectDir = value;
      i += 1;
    } else if (arg === "--from-clerk") {
      args.fromClerk = true;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--delete-source") {
      args.deleteSource = true;
    } else {
      const match = /^([^=]+)=([^=]+)$/.exec(arg);
      if (match === null) return fail(`"${arg}" is not an old=new pair`);
      args.pairs.push({ from: match[1] as string, to: match[2] as string });
    }
  }
  if (args.fromClerk && args.pairs.length > 0) return fail("give pairs or --from-clerk, not both");
  if (!args.fromClerk && args.pairs.length === 0) return fail("give old=new pairs or --from-clerk");
  return { success: true, args };
}
