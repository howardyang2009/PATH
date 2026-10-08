import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authoredLayout } from "../src/authored-layout.js";
import {
  adoptSharedItems,
  type CreatorTable,
  openCreatorTable,
  sharedWriteRefusal,
} from "../src/creator-table.js";

let projectDir: string;
let creators: CreatorTable;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "path-creator-table-"));
  creators = openCreatorTable(join(projectDir, ".path", "host.db"));
});

afterEach(() => {
  creators.close();
  rmSync(projectDir, { recursive: true, force: true });
});

function write(relPath: string): void {
  mkdirSync(join(projectDir, relPath, ".."), { recursive: true });
  writeFileSync(join(projectDir, relPath), "{}");
}

describe("creator table", () => {
  it("keeps one creator per path and kind, replaced by a stamp and removed by forget", () => {
    creators.stamp("shared/workflow/a.workflow.json", "workflow", "user_a");
    expect(creators.creatorOf("shared/workflow/a.workflow.json", "workflow")).toBe("user_a");
    expect(creators.creatorOf("shared/workflow/a.workflow.json", "template")).toBeUndefined();

    creators.stamp("shared/workflow/a.workflow.json", "workflow", "user_b");
    expect(creators.creatorOf("shared/workflow/a.workflow.json", "workflow")).toBe("user_b");

    creators.forget("shared/workflow/a.workflow.json", "workflow");
    expect(creators.creatorOf("shared/workflow/a.workflow.json", "workflow")).toBeUndefined();
  });

  it("refuses a shared write by anyone but the creator, and passes any other origin", () => {
    const alice = authoredLayout({ projectDir, userId: "user_alice" });
    const bob = authoredLayout({ projectDir, userId: "user_bob" });
    const path = "shared/workflow/a.workflow.json";
    creators.stamp(path, "workflow", "user_alice");

    expect(sharedWriteRefusal(alice, creators, path, "workflow")).toBeUndefined();
    expect(sharedWriteRefusal(bob, creators, `./${path}`, "workflow")).toMatchObject({
      status: 403,
    });
    expect(
      sharedWriteRefusal(bob, creators, "shared/workflow/none.workflow.json", "workflow"),
    ).toMatchObject({ status: 403 });
    expect(
      sharedWriteRefusal(bob, creators, "users/user_bob/workflow/x.workflow.json", "workflow"),
    ).toBeUndefined();
  });

  it("adopts untracked shared files for the layout's user and keeps existing rows", () => {
    write("shared/workflow/sub/a.workflow.json");
    write("shared/template/t.step-template.json");
    write("users/local/workflow/mine.workflow.json");
    creators.stamp("shared/workflow/b.workflow.json", "workflow", "user_x");
    write("shared/workflow/b.workflow.json");

    adoptSharedItems(authoredLayout({ projectDir }), creators);

    expect(creators.creatorOf("shared/workflow/sub/a.workflow.json", "workflow")).toBe("local");
    expect(creators.creatorOf("shared/template/t.step-template.json", "template")).toBe("local");
    expect(creators.creatorOf("shared/workflow/b.workflow.json", "workflow")).toBe("user_x");
    expect(
      creators.creatorOf("users/local/workflow/mine.workflow.json", "workflow"),
    ).toBeUndefined();
  });

  it("reassigns every row of one user to another and counts them", () => {
    creators.stamp("shared/workflow/a.workflow.json", "workflow", "local");
    creators.stamp("shared/template/b.step-template.json", "template", "local");
    creators.stamp("shared/workflow/c.workflow.json", "workflow", "user_other");

    expect(creators.reassign("local", "user_new")).toBe(2);
    expect(creators.countBy("user_new")).toBe(2);
    expect(creators.countBy("local")).toBe(0);
    expect(creators.creatorOf("shared/workflow/c.workflow.json", "workflow")).toBe("user_other");
  });
});
