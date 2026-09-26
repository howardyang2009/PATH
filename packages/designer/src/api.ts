import { PathApiClient } from "@path/client-core";

/** Default API client: same-origin relative URLs (`/v0/...`), which dev proxies and prod serves alike. */
export const apiClient = new PathApiClient({ baseUrl: "" });
