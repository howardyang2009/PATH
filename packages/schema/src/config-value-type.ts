export interface EnvWrapper {
  $env: string;
}

// `$secret` widens past a literal to hold an `$env` wrapper: the two compose by nesting
// (`{"$secret": {"$env": "NAME"}}` sources *and* marks secret). Masking is by value (mvp-spec.md §8.3),
// so "env is always secret" would scrub an env-sourced model name out of every log event in the run.
export interface SecretWrapper {
  $secret: string | EnvWrapper;
}

export type ConfigValue =
  | string
  | number
  | boolean
  | null
  | SecretWrapper
  | EnvWrapper
  | ConfigValue[]
  | { [key: string]: ConfigValue };

export type ConfigObject = { [key: string]: ConfigValue };
