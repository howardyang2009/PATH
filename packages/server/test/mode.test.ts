import { describe, expect, it } from "vitest";
import { readServerMode } from "../src/mode.js";
import { JWT_KEY, ORIGIN, PUBLISHABLE_KEY } from "./fixtures/clerk-token.js";

describe("readServerMode", () => {
  it("is local with no Clerk settings", () => {
    expect(readServerMode({})).toEqual({ mode: "local", publishableKey: null });
  });

  it("is hosted with both settings and the publishable key", () => {
    expect(
      readServerMode({
        CLERK_JWT_KEY: JWT_KEY,
        PATH_ALLOWED_ORIGIN: ORIGIN,
        CLERK_PUBLISHABLE_KEY: PUBLISHABLE_KEY,
      }),
    ).toEqual({
      mode: "hosted",
      publishableKey: PUBLISHABLE_KEY,
      clerk: { jwtKey: JWT_KEY, allowedOrigin: ORIGIN },
    });
  });

  it("refuses CLERK_JWT_KEY alone", () => {
    expect(() => readServerMode({ CLERK_JWT_KEY: JWT_KEY })).toThrow(/PATH_ALLOWED_ORIGIN/);
  });

  it("refuses PATH_ALLOWED_ORIGIN alone", () => {
    expect(() => readServerMode({ PATH_ALLOWED_ORIGIN: ORIGIN })).toThrow(/CLERK_JWT_KEY/);
  });

  it("refuses hosted mode without a publishable key", () => {
    expect(() => readServerMode({ CLERK_JWT_KEY: JWT_KEY, PATH_ALLOWED_ORIGIN: ORIGIN })).toThrow(
      /CLERK_PUBLISHABLE_KEY/,
    );
  });
});
