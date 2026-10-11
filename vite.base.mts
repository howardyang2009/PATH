// The repo root has no `vite` dependency, so the plugin types only the bundle fields it reads.
interface BundleItem {
  type: "chunk" | "asset";
  isEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
  moduleIds?: string[];
}

const CLERK_MODULE = /[\\/]@clerk[\\/](clerk-js|ui)[\\/]/;

/**
 * Adds `<link rel="modulepreload">` for the Clerk chunks, so a hosted page downloads them beside the
 * main bundle and not after `/v0/auth-config` settles. Preloaded modules do not run: local mode
 * still never evaluates Clerk.
 */
export function preloadClerk() {
  let base = "/";
  return {
    name: "path-preload-clerk",
    apply: "build" as const,
    configResolved(config: { base: string }) {
      base = config.base;
    },
    transformIndexHtml: {
      order: "post" as const,
      handler(_html: string, { bundle }: { bundle?: Record<string, BundleItem> }) {
        if (!bundle) return;
        const walk = (fileName: string, into: Set<string>): void => {
          const item = bundle[fileName];
          if (into.has(fileName) || item?.type !== "chunk") return;
          into.add(fileName);
          for (const dep of item.imports ?? []) walk(dep, into);
        };
        // The entry's static graph is already in the page.
        const loaded = new Set<string>();
        for (const [fileName, item] of Object.entries(bundle))
          if (item.isEntry) walk(fileName, loaded);
        // Only the Clerk chunks the app itself imports, not the ones Clerk lazy-loads per component.
        const clerk = new Set<string>();
        for (const fileName of loaded) {
          for (const target of bundle[fileName]?.dynamicImports ?? []) {
            if (bundle[target]?.moduleIds?.some((id) => CLERK_MODULE.test(id))) walk(target, clerk);
          }
        }
        return [...clerk]
          .filter((fileName) => !loaded.has(fileName))
          .map((fileName) => ({
            tag: "link",
            attrs: { rel: "modulepreload", crossorigin: true, href: `${base}${fileName}` },
            injectTo: "head" as const,
          }));
      },
    },
  };
}

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
