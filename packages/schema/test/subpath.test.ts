import { childBodies, walkNodes } from "@path/schema/node-walk";
import { makeNodeSchema, RESERVED_TYPE_NAMES } from "@path/schema/nodes";
import { fromWireRunRecord, toRootRunSummary, toWireRunRecord } from "@path/schema/wire-v0";
import { describe, expect, it } from "vitest";
import * as barrel from "../src/index.js";

/**
 * `@path/schema`'s subpaths are seams a consumer can name an owner with (the block grammar, the wire
 * codec) instead of pulling the whole 200-name barrel. A package `exports` map is not checked by tsc
 * alone — a typo'd path type-checks nowhere and fails at run time — so each subpath is resolved here
 * and compared to the barrel entry it names.
 */

describe("@path/schema/nodes", () => {
  it("hands out the barrel's own node schema factory", () => {
    expect(makeNodeSchema).toBe(barrel.makeNodeSchema);
    expect(RESERVED_TYPE_NAMES).toBe(barrel.RESERVED_TYPE_NAMES);
  });
});

describe("@path/schema/node-walk", () => {
  it("hands out the barrel's own block-grammar descent", () => {
    expect(childBodies).toBe(barrel.childBodies);
    expect(walkNodes).toBe(barrel.walkNodes);
  });
});

describe("@path/schema/wire-v0", () => {
  it("hands out the barrel's own wire codec", () => {
    expect(toWireRunRecord).toBe(barrel.toWireRunRecord);
    expect(fromWireRunRecord).toBe(barrel.fromWireRunRecord);
    expect(toRootRunSummary).toBe(barrel.toRootRunSummary);
  });
});
