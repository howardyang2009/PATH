import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { isCrossOriginWrite } from "../src/origin-gate.js";

/** A minimal `IncomingMessage` stand-in — the gate only reads `.headers`. */
function req(headers: Record<string, string | string[] | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe("isCrossOriginWrite", () => {
  describe("Sec-Fetch-Site is decisive when present", () => {
    it("allows same-origin (our own viewer)", () => {
      expect(isCrossOriginWrite(req({ "sec-fetch-site": "same-origin" }))).toBe(false);
    });

    it("allows none (a user-initiated load: address bar, bookmark)", () => {
      expect(isCrossOriginWrite(req({ "sec-fetch-site": "none" }))).toBe(false);
    });

    it("rejects cross-site (the CSRF vector: a page on another site)", () => {
      expect(isCrossOriginWrite(req({ "sec-fetch-site": "cross-site" }))).toBe(true);
    });

    it("rejects same-site (a different origin under the same registrable domain)", () => {
      expect(isCrossOriginWrite(req({ "sec-fetch-site": "same-site" }))).toBe(true);
    });

    it("ignores Origin when Sec-Fetch-Site says same-origin", () => {
      expect(
        isCrossOriginWrite(req({ "sec-fetch-site": "same-origin", origin: "http://evil.com", host: "localhost:5173" })),
      ).toBe(false);
    });

    it("rejects on Sec-Fetch-Site even if an Origin happens to match Host", () => {
      expect(
        isCrossOriginWrite(req({ "sec-fetch-site": "cross-site", origin: "http://localhost:5173", host: "localhost:5173" })),
      ).toBe(true);
    });
  });

  describe("Origin vs Host fallback when Sec-Fetch-Site is absent", () => {
    it("allows a request with no Origin (a non-browser client — the CLI, curl — is not a CSRF vector)", () => {
      expect(isCrossOriginWrite(req({ host: "localhost:5173" }))).toBe(false);
    });

    it("allows an Origin whose host matches Host", () => {
      expect(isCrossOriginWrite(req({ origin: "http://localhost:5173", host: "localhost:5173" }))).toBe(false);
    });

    it("rejects an Origin whose host differs from Host", () => {
      expect(isCrossOriginWrite(req({ origin: "http://evil.com", host: "localhost:5173" }))).toBe(true);
    });

    it("rejects an Origin on the same host but a different port", () => {
      expect(isCrossOriginWrite(req({ origin: "http://localhost:9999", host: "localhost:5173" }))).toBe(true);
    });

    it('rejects the opaque-origin sentinel "null"', () => {
      expect(isCrossOriginWrite(req({ origin: "null", host: "localhost:5173" }))).toBe(true);
    });

    it("rejects a malformed Origin (not a parseable URL)", () => {
      expect(isCrossOriginWrite(req({ origin: "http://[", host: "localhost:5173" }))).toBe(true);
    });
  });

  describe("header arrays (duplicate headers) take the first value", () => {
    it("reads the first Sec-Fetch-Site of an array", () => {
      expect(isCrossOriginWrite(req({ "sec-fetch-site": ["cross-site", "same-origin"] }))).toBe(true);
    });
  });
});
