import { describe, expect, it } from "vitest";
import { containerRunArgs } from "../src/sandbox/apple-container.js";

describe("containerRunArgs", () => {
  it("names each variable bare, so no value reaches the command line", () => {
    const args = containerRunArgs({
      name: "path-run-r1",
      labels: { "path.sandbox": "run" },
      image: "path-run:1",
      command: ["/job/job.json"],
      mounts: [
        { hostPath: "/h/io", guestPath: "/h/io", readOnly: false },
        { hostPath: "/h/wf", guestPath: "/h/wf", readOnly: true },
      ],
      env: { API_TOKEN: "sk-secret" },
      cpus: 4,
      memoryMiB: 4096,
      network: "path",
    });
    expect(args).toEqual([
      "run",
      "--rm",
      "--init",
      "--name",
      "path-run-r1",
      "--label",
      "path.sandbox=run",
      "--cpus",
      "4",
      "--memory",
      "4096M",
      "--network",
      "path",
      "--env",
      "API_TOKEN",
      "--volume",
      "/h/io:/h/io",
      "--volume",
      "/h/wf:/h/wf:ro",
      "path-run:1",
      "/job/job.json",
    ]);
    expect(args.join(" ")).not.toContain("sk-secret");
  });
});
