import { defineStepPlugin, z } from "@path/engine/plugin";

const fields = {
  description: z.string(),
  outputSchema: z.record(z.unknown()).optional(),
  assignee: z.string().optional(),
};

const config = {};

export const stepPlugin = defineStepPlugin({
  fields,
  config,
  workers: {
    manual: {
      meters: false,
      needsProcessorSlot: false,
      run: async () => ({ status: "awaiting" as const }),
    },
  },
  defaultWorker: "manual",
});
