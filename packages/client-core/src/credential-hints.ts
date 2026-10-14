/** The config key, or User secret name, each prompt worker reads its provider credential from
 * (ADR 0045). */
const CREDENTIAL_KEYS: { readonly [worker: string]: string } = {
  anthropic: "CLAUDE_CODE_OAUTH_TOKEN",
  deepseek: "DEEPSEEK_API_KEY",
};

/** The one-line auth hint an editor shows for a worker; `undefined` for a worker with no
 * credential. */
export function credentialHint(worker: string | undefined): string | undefined {
  const key = worker === undefined ? undefined : CREDENTIAL_KEYS[worker];
  if (key === undefined) return undefined;
  const source = worker === "anthropic" ? " (from `claude setup-token`)" : "";
  return `Auth: set config ${key}${source} or a User secret of that name.`;
}

/** A launch config placeholder naming the credential of every given worker, as a `$secret`;
 * `undefined` when none of them needs one. */
export function credentialPlaceholder(workers: Iterable<string>): string | undefined {
  const keys = new Set<string>();
  for (const worker of workers) {
    const key = CREDENTIAL_KEYS[worker];
    if (key !== undefined) keys.add(key);
  }
  if (keys.size === 0) return undefined;
  const entries = [...keys].map((key) => `"${key}": {"$secret": "…"}`);
  return `{${entries.join(", ")}}`;
}
