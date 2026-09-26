import { PathApiClient } from "@path/client-core";

/** Same-origin relative URLs: the Vite proxy forwards them in dev, `path-server` serves both in prod. */
export const apiClient = new PathApiClient({ baseUrl: "" });
