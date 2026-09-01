/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Where the dev server proxies the v0 API. The serve model (map #40): dev = Vite proxies `/v0/*`
 * to a running `path-server`; prod = `path-server` serves this build's static bundle from
 * `packages/viewer/dist` (one origin, no CORS). Override the target with `PATH_SERVER_URL` when the
 * server runs on a non-default port (`path-server --port <n>`).
 */
const SERVER_TARGET = process.env.PATH_SERVER_URL ?? "http://localhost:8787";

export default defineConfig({
  // The Viewer is mounted at `/viewer/` on `path-server` (#360, ADR 0027), so its built asset URLs
  // must resolve under that prefix. `path-server` 302-redirects bare `/` to `/viewer/`.
  base: "/viewer/",
  plugins: [react()],
  server: {
    proxy: {
      "/v0": { target: SERVER_TARGET, changeOrigin: true },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    css: false,
  },
});
