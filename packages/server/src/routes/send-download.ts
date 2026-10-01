import type { ServerResponse } from "node:http";

/** `Content-Disposition: attachment` for `fileName`: an ASCII fallback plus the RFC 5987 form. */
function attachment(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/** Answer `200` with `bytes` as a file download. */
export function sendDownload(
  res: ServerResponse,
  download: { contentType: string; fileName: string; bytes: Uint8Array; etag?: string },
): void {
  res.writeHead(200, {
    "Content-Type": download.contentType,
    "Content-Disposition": attachment(download.fileName),
    ...(download.etag === undefined ? {} : { ETag: download.etag }),
  });
  res.end(download.bytes);
}
