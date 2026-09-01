import { PathApiClient } from "@path/client-core";

/**
 * The default API client for the running Designer: same-origin, relative URLs (`/v0/...`). In dev the
 * Vite proxy forwards those to `path-server`; in prod `path-server` serves this bundle and the API from
 * one origin (map #40 serve model), so an empty base URL is correct in both. Tests inject their own
 * client instead of using this.
 */
export const apiClient = new PathApiClient({ baseUrl: "" });
