/**
 * The Vite settings the two consoles share. Dev proxies `/v0/*` to a running `path-server`; prod
 * has `path-server` serve each console's static bundle under its mount (`base`), one origin, no
 * CORS. Set `PATH_SERVER_URL` when the server runs on a non-default port (`path-server --port
 * <n>`).
 */
export function consoleConfig(base: string) {
  return {
    base,
    server: {
      proxy: {
        "/v0": {
          target: process.env.PATH_SERVER_URL ?? "http://localhost:8787",
          changeOrigin: true,
        },
      },
    },
    test: {
      environment: "jsdom",
      globals: true,
      setupFiles: ["./test/setup.ts"],
      css: false,
    },
  };
}
