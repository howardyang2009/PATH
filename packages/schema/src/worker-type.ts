export interface EngineWorker {
  type: "engine";
}

export interface LlmWorker {
  type: "llm";
  model: string;
  options?: Record<string, unknown>;
}

export type Worker = EngineWorker | LlmWorker;
