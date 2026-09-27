type TakeValueResult = { success: true; value: string } | { success: false; error: string };

// The argument after a value-flag at `args[i]`, or a usage error naming the flag. The caller advances
// `i`; `noun` is the flag's own wording ("a path", "a guid").
export function takeValue(
  args: string[],
  i: number,
  flag: string,
  noun: string,
  usage: string,
): TakeValueResult {
  const value = args[i + 1];
  if (!value) return { success: false, error: `${flag} requires ${noun} argument\n${usage}` };
  return { success: true, value };
}

type TakePairResult = { success: true; pair: [string, string] } | { success: false; error: string };

// The `<key>=<value>` argument after a pair-flag, split at the first `=`; the key must be non-empty and
// `valueRequired` also refuses an empty value (unlike an empty config string).
export function takePair(
  args: string[],
  i: number,
  flag: string,
  shape: string,
  usage: string,
  { valueRequired = false }: { valueRequired?: boolean } = {},
): TakePairResult {
  const pair = args[i + 1];
  const eq = pair?.indexOf("=") ?? -1;
  if (!pair || eq <= 0 || (valueRequired && eq === pair.length - 1)) {
    return { success: false, error: `${flag} requires a ${shape} argument\n${usage}` };
  }
  return { success: true, pair: [pair.slice(0, eq), pair.slice(eq + 1)] };
}

export type PositiveIntResult =
  | { success: true; value: number }
  | { success: false; error: string };

// The one positive-integer flag check, shared by `--processor-concurrency` and `runs`' `--limit`;
// `flag`/`usage` name the offending flag and its command's usage.
export function parsePositiveInt(
  flag: string,
  value: string | undefined,
  usage: string,
): PositiveIntResult {
  const parsed = Number(value);
  if (!value || !Number.isInteger(parsed) || parsed <= 0) {
    return { success: false, error: `${flag} requires a positive integer\n${usage}` };
  }
  return { success: true, value: parsed };
}

// `-C <dir>` can appear anywhere in a `runs` invocation, ahead of or behind the subcommand, so it is
// stripped before the rest of parsing sees it rather than pinned to one position.
type ExtractDirFlagResult =
  | { success: true; dir: string | undefined; rest: string[] }
  | { success: false; error: string };

export function extractDirFlag(args: string[], usage: string): ExtractDirFlagResult {
  const rest: string[] = [];
  let dir: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "-C") {
      const value = args[i + 1];
      if (!value) return { success: false, error: `-C requires a directory argument\n${usage}` };
      dir = value;
      i += 1;
    } else {
      rest.push(args[i]!);
    }
  }
  return { success: true, dir, rest };
}
