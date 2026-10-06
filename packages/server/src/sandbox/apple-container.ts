import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import type { SandboxProcess, SandboxRuntime, SandboxSpec } from "./sandbox-runtime.js";

/** The `container run` arguments for one spec. Each variable is named bare (`--env NAME`), so the
 * CLI copies its value from its own environment and no value shows in the host's process list. */
export function containerRunArgs(spec: SandboxSpec): string[] {
  const args = ["run", "--rm", "--init", "--name", spec.name];
  for (const [key, value] of Object.entries(spec.labels)) args.push("--label", `${key}=${value}`);
  args.push("--cpus", String(spec.cpus), "--memory", `${spec.memoryMiB}M`);
  if (spec.network !== undefined) args.push("--network", spec.network);
  for (const name of Object.keys(spec.env)) args.push("--env", name);
  for (const mount of spec.mounts) {
    args.push("--volume", `${mount.hostPath}:${mount.guestPath}${mount.readOnly ? ":ro" : ""}`);
  }
  args.push(spec.image, ...spec.command);
  return args;
}

const run = promisify(execFile);

/** Apple `container` as the sandbox runtime. It must run as the login user, never root. */
export function appleContainerRuntime(binary = "container"): SandboxRuntime {
  return {
    launch(spec, onLine): SandboxProcess {
      // The CLI needs the host environment to reach its API server; only `spec.env` names pass on.
      const child = spawn(binary, containerRunArgs(spec), {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...spec.env },
      });
      createInterface({ input: child.stdout }).on("line", onLine);
      createInterface({ input: child.stderr }).on("line", (line) =>
        console.error(`sandbox ${spec.name}: ${line}`),
      );

      const exited = new Promise<number | null>((resolve) => {
        child.once("error", (err) => {
          console.error(`sandbox ${spec.name}: ${err.message}`);
          resolve(null);
        });
        child.once("close", (code) => resolve(code));
      });

      const signal = (name: string): void => {
        spawn(binary, ["kill", "--signal", name, spec.name], { stdio: "ignore" }).on(
          "error",
          () => {},
        );
      };
      return { exited, terminate: () => signal("TERM"), kill: () => signal("KILL") };
    },

    async list(key, value) {
      const { stdout } = await run(binary, ["list", "--all", "--format", "json"]);
      const vms = JSON.parse(stdout) as { id: string; configuration?: { labels?: object } }[];
      return vms
        .filter((vm) => (vm.configuration?.labels as Record<string, string>)?.[key] === value)
        .map((vm) => vm.id);
    },

    async remove(name) {
      await run(binary, ["delete", "--force", name]);
    },
  };
}
