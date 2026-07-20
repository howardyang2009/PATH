import { existsSync, readFileSync } from "node:fs";
import { formatIssues } from "@path/schema";
import { z } from "zod";
import { LOG_BACKEND_IDS, type LogBackendId } from "../logging/backends.js";
import { engineSettingsFilePath } from "../persistence/paths.js";

/**
 * Keys are spelled as the spec names the settings (`log.backends`, §8.2 — the LLM cap, §5.5),
 * dots and all: this is a flat settings file, not a nested object, so a dot is just a character.
 */
const EngineSettingsFileSchema = z
  .object({
    "log.backends": z.array(z.enum(LOG_BACKEND_IDS)).optional(),
    "llm.concurrency": z.number().int().positive().optional(),
  })
  .strict();

/**
 * The engine-level operator settings (mvp spec §9, ticket #27): the two knobs the engine itself
 * reads. Deliberately *not* workflow Config — Config is read by steps and inherits per file,
 * while these are read by the engine and the LLM cap in particular is one engine-wide value.
 * Every field is optional: absent means "fall back to the built-in default".
 */
export interface EngineSettings {
  logBackends?: LogBackendId[];
  llmConcurrency?: number;
}

export type LoadEngineSettingsResult =
  | { success: true; settings: EngineSettings }
  | { success: false; error: string };

/** Reads `.path/settings.json`; an absent file yields no settings, i.e. the built-in defaults. */
export function loadEngineSettings(projectDir: string): LoadEngineSettingsResult {
  const file = engineSettingsFilePath(projectDir);
  if (!existsSync(file)) return { success: true, settings: {} };

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return { success: false, error: `${file}: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Strict-unknown-field, like the workflow format: a typo'd key is a settings file that does not
  // do what its author thinks, so it fails loudly rather than being silently ignored.
  const parsed = EngineSettingsFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = formatIssues(parsed.error);
    return { success: false, error: [`${file}: invalid engine-settings file`, ...issues].join("\n") };
  }

  const settings: EngineSettings = {};
  if (parsed.data["log.backends"] !== undefined) settings.logBackends = parsed.data["log.backends"];
  if (parsed.data["llm.concurrency"] !== undefined) settings.llmConcurrency = parsed.data["llm.concurrency"];
  return { success: true, settings };
}
