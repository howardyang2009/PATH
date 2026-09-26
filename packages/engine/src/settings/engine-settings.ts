import { existsSync, readFileSync } from "node:fs";
import { formatIssues } from "@path/schema";
import { z } from "zod";
import { LOG_BACKEND_IDS, type LogBackendId } from "../logging/backends.js";
import { engineSettingsFilePath } from "../persistence/paths.js";

/**
 * Flat keys spelled as the spec names the settings (`log.backends` §8.2, `processor.concurrency` §5.5) — a dot is
 * just a character.
 */
const EngineSettingsFileSchema = z
  .object({
    "log.backends": z.array(z.enum(LOG_BACKEND_IDS)).optional(),
    "processor.concurrency": z.number().int().positive().optional(),
  })
  .strict();

/**
 * The engine-level operator settings (mvp spec §9): the two knobs the engine itself reads,
 * deliberately not workflow Config. Every field is optional — absent means the built-in default.
 */
export interface EngineSettings {
  logBackends?: LogBackendId[];
  processorConcurrency?: number;
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
    return {
      success: false,
      error: `${file}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Strict unknown fields, like the workflow format: a typo'd key fails loudly rather than being ignored.
  const parsed = EngineSettingsFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = formatIssues(parsed.error);
    return {
      success: false,
      error: [`${file}: invalid engine-settings file`, ...issues].join("\n"),
    };
  }

  const settings: EngineSettings = {};
  if (parsed.data["log.backends"] !== undefined) settings.logBackends = parsed.data["log.backends"];
  if (parsed.data["processor.concurrency"] !== undefined)
    settings.processorConcurrency = parsed.data["processor.concurrency"];
  return { success: true, settings };
}
