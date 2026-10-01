import { type PathApiClient, PathApiError } from "@path/client-core";
import type { DownloadPlan } from "./session-reducer.js";

/** Fetch the plan's file and hand it to the browser as a save. */
export async function downloadFile(client: PathApiClient, plan: DownloadPlan): Promise<void> {
  const { fileName, blob } =
    plan.kind === "template"
      ? await client.downloadTemplate(plan.id)
      : await client.downloadWorkflow(plan.path);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** The text of a failed download: the server's message, then one line per `ref` it could not
 * follow. */
export function downloadFailure(error: unknown): string {
  if (!(error instanceof PathApiError)) {
    return error instanceof Error ? error.message : String(error);
  }
  const lines = Array.isArray(error.details)
    ? error.details.map((item) => {
        const { ref, from, reason } = item as { ref: string; from: string; reason: string };
        return `${ref} (in ${from}): ${reason}`;
      })
    : [];
  return [error.message, ...lines].join("\n");
}
