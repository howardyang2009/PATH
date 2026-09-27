/** Return `value`, or throw when it is `undefined` or `null`. Use it where the code relies on an
 * invariant that the type system cannot see (a lookup that always hits, a non-empty list). */
export function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`invariant broken: missing ${what}`);
  return value;
}
