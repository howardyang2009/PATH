import { defineStepPlugin, z } from "@path/engine/plugin";

const fields = {
  description: z.string(),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  assignee: z.string().optional(),
};

const config = {};

export const stepPlugin = defineStepPlugin({
  fields,
  config,
  workers: {
    person: {
      meters: false,
      needsProcessorSlot: false,
      // The park carries the interpolated `assignee` (#488) so the `step-awaiting` audit record names
      // who the offline activity is for — reconstructable from the log alone, not only from the file.
      // `assignee` is optional (CONTEXT § Person-activity), so it is echoed only when the node sets it.
      run: async ({ fields }) => ({ status: "awaiting" as const, assignee: fields.assignee }),
    },
  },
  defaultWorker: "person",
});
