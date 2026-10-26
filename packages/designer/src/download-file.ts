import { apiErrorMessage, type PathApiClient, PathApiError } from "@path/client-core";
import type { Message } from "@path/i18n";
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

/** The lines of a failed download: the server's message, then one per `ref` it could not
 * follow. */
export function downloadFailure(error: unknown): Message[] {
  if (!(error instanceof PathApiError)) {
    return [apiErrorMessage(error)];
  }
  const lines: Message[] = Array.isArray(error.details)
    ? error.details.map((item) => {
        const { ref, from, reason } = item as { ref: string; from: string; reason: string };
        return { key: "designer.download.unbundledRef", params: { ref, from, reason } };
      })
    : [];
  return [apiErrorMessage(error), ...lines];
}
