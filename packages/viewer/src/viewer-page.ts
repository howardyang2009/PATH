import { useCallback, useEffect, useState } from "react";

/** Where `path-server` and the Vite dev server mount the Viewer (ADR 0027). */
const VIEWER_BASE = "/viewer/";
const PATHS = { console: VIEWER_BASE, secrets: `${VIEWER_BASE}secrets` } as const;

export type ViewerPage = keyof typeof PATHS;

export function viewerPath(page: ViewerPage): string {
  return PATHS[page];
}

/** The Viewer's page, read from the URL. `go` pushes a history entry, so the back button returns. */
export function useViewerPage(): { page: ViewerPage; go: (page: ViewerPage) => void } {
  const [pathname, setPathname] = useState(() => window.location.pathname);
  useEffect(() => {
    const onPopState = (): void => setPathname(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  const go = useCallback((page: ViewerPage): void => {
    if (window.location.pathname !== PATHS[page]) window.history.pushState(null, "", PATHS[page]);
    setPathname(PATHS[page]);
  }, []);
  const page = pathname.replace(/\/$/, "") === PATHS.secrets ? "secrets" : "console";
  return { page, go };
}
