export interface SecretWrapper {
  $secret: string;
}

export type ConfigValue =
  | string
  | number
  | boolean
  | null
  | SecretWrapper
  | ConfigValue[]
  | { [key: string]: ConfigValue };

export type ConfigObject = { [key: string]: ConfigValue };
