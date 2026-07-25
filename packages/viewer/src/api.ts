import { PathApiClient } from "@path/client-core";

/**
 * The default API client for the running app: same-origin, relative URLs (`/v0/...`). In dev the
 * Vite proxy forwards those to `path-server`; in prod `path-server` serves both this bundle and the
 * API from one origin (map #40 serve model) — so an empty base URL is correct in both. Tests and
 * the smoke screen inject their own client instead of using this.
 */
export const apiClient = new PathApiClient({ baseUrl: "" });
