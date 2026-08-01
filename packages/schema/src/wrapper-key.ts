/**
 * The sole-key rule shared by every `$`-prefixed config wrapper (`$secret`, `$env`): a wrapper is a
 * marking, so the marker must be the object's *only* key. A multi-key object that merely carries a
 * `$secret` or `$env` field is a plain config object — otherwise an author's ordinary object would
 * silently become a wrapper the moment it grew a field with that name.
 *
 * One owner, because the rule is what `secret.ts` and `env.ts` must agree on: the walks meet on the
 * composed `{"$secret": {"$env": "NAME"}}` form, and a wrapper each recognises differently is the
 * drift `secret.ts` was written to end.
 */
export function hasOnlyKey(value: object, key: string): boolean {
  return Object.keys(value).length === 1 && Object.prototype.hasOwnProperty.call(value, key);
}
