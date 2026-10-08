import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readServerMode } from "../src/mode.js";
import { DEFAULT_LIMITS } from "../src/request-limits.js";
import { parseSecretsKey } from "../src/secret-store.js";
import { JWT_KEY, ORIGIN, PUBLISHABLE_KEY, SECRETS_KEY } from "./fixtures/clerk-token.js";
import { stubEgressAnchor } from "./fixtures/egress-status.js";
import { fakeRuntime } from "./fixtures/fake-sandbox.js";

let projectDir: string;
let hosted: NodeJS.ProcessEnv;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "path-mode-test-"));
  stubEgressAnchor();
  hosted = {
    CLERK_JWT_KEY: JWT_KEY,
    PATH_ALLOWED_ORIGIN: ORIGIN,
    CLERK_PUBLISHABLE_KEY: PUBLISHABLE_KEY,
    PATH_SECRETS_KEY: SECRETS_KEY,
    PATH_SANDBOX_IMAGE: "path-run:test",
    PATH_EGRESS_STATUS: process.env.PATH_EGRESS_STATUS,
  };
  vi.unstubAllEnvs();
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

const read = (env: NodeJS.ProcessEnv) =>
  readServerMode(
    env,
    projectDir,
    fakeRuntime(async () => 0),
  );

describe("readServerMode", () => {
  it("is local with no Clerk settings", () => {
    expect(read({})).toEqual({ mode: "local", publishableKey: null });
  });

  it("is hosted when every item of the gate holds", () => {
    const mode = read(hosted);
    expect(mode).toMatchObject({
      mode: "hosted",
      publishableKey: PUBLISHABLE_KEY,
      clerk: { jwtKey: JWT_KEY, allowedOrigin: ORIGIN },
      secretsKey: parseSecretsKey(SECRETS_KEY),
      sandbox: { image: "path-run:test", network: "path" },
    });
    if (mode.mode !== "hosted") throw new Error("expected hosted mode");
    expect(mode.limits.forUser("user_abc")).toEqual(DEFAULT_LIMITS);
  });

  it.each([
    ["CLERK_PUBLISHABLE_KEY", /CLERK_PUBLISHABLE_KEY is not set/],
    ["PATH_SECRETS_KEY", /PATH_SECRETS_KEY is not set/],
    ["PATH_SANDBOX_IMAGE", /SandboxedRuns.*PATH_SANDBOX_IMAGE.*in-process runs are refused/],
    ["PATH_EGRESS_STATUS", /pf anchor `path` is not loaded/],
  ])("refuses hosted mode without %s and names it", (name, named) => {
    const env = { ...hosted, [name]: undefined };
    if (name === "PATH_EGRESS_STATUS") env.PATH_EGRESS_STATUS = join(projectDir, "missing");
    expect(() => read(env)).toThrow(named);
    expect(() => read(env)).toThrow(/hosted mode refuses to start/);
  });

  it("refuses hosted mode when the abuse limits cannot be read", () => {
    mkdirSync(join(projectDir, ".path"), { recursive: true });
    writeFileSync(join(projectDir, ".path", "limits.json"), "{ not json");
    expect(() => read(hosted)).toThrow(/abuse limits: .*limits\.json is not valid JSON/);
  });

  it("names every missing item in one refusal", () => {
    const env = {
      ...hosted,
      CLERK_PUBLISHABLE_KEY: undefined,
      PATH_SECRETS_KEY: undefined,
      PATH_SANDBOX_IMAGE: undefined,
      PATH_EGRESS_STATUS: join(projectDir, "missing"),
    };
    expect(() => read(env)).toThrow(
      /CLERK_PUBLISHABLE_KEY[\s\S]*PATH_SECRETS_KEY[\s\S]*PATH_SANDBOX_IMAGE[\s\S]*pf anchor/,
    );
  });

  it("reads the previous secrets key during a rotation", () => {
    const previous = Buffer.alloc(32, 7).toString("base64");
    const mode = read({ ...hosted, PATH_SECRETS_KEY_PREVIOUS: previous });
    expect(mode).toMatchObject({
      secretsKey: parseSecretsKey(SECRETS_KEY),
      previousSecretsKey: parseSecretsKey(previous),
    });
  });

  it("refuses a malformed previous secrets key", () => {
    expect(() => read({ ...hosted, PATH_SECRETS_KEY_PREVIOUS: "short" })).toThrow(
      /PATH_SECRETS_KEY_PREVIOUS/,
    );
  });

  it("refuses hosted mode with a malformed secrets key", () => {
    expect(() => read({ ...hosted, PATH_SECRETS_KEY: "short" })).toThrow(/PATH_SECRETS_KEY/);
  });

  it("refuses CLERK_JWT_KEY alone", () => {
    expect(() => read({ ...hosted, PATH_ALLOWED_ORIGIN: undefined })).toThrow(
      /PATH_ALLOWED_ORIGIN is not set/,
    );
  });

  it("refuses PATH_ALLOWED_ORIGIN alone", () => {
    expect(() => read({ ...hosted, CLERK_JWT_KEY: undefined })).toThrow(/CLERK_JWT_KEY is not set/);
  });
});
