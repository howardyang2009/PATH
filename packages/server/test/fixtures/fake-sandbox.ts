import { mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { dirname } from "node:path";
import type {
  SandboxProcess,
  SandboxRuntime,
  SandboxSpec,
} from "../../src/sandbox/sandbox-runtime.js";
import { runVmJob, type VmJob } from "../../src/sandbox/vm-entry.js";

/** One VM the fake runtime started: its spec, its stdout, and the stop requests it received. */
export interface FakeVm {
  spec: SandboxSpec;
  emit(line: string): void;
  /** Aborts on `terminate`. */
  terminated: AbortSignal;
  killed: boolean;
  /** The job file the host wrote (the command's last argument), read at launch. */
  job(): VmJob;
}

/** A behaviour decides what a VM does and resolves with its exit code. */
export type FakeBehaviour = (vm: FakeVm) => Promise<number | null>;

/** A runtime that runs each VM as `behaviour`, recording every VM it started. */
export function fakeRuntime(
  behaviour: FakeBehaviour,
  orphans: string[] = [],
): SandboxRuntime & { vms: FakeVm[]; removed: string[] } {
  const vms: FakeVm[] = [];
  const removed: string[] = [];
  return {
    vms,
    removed,
    async list() {
      return orphans.filter((name) => !removed.includes(name));
    },
    async remove(name) {
      removed.push(name);
    },
    launch(spec, onLine): SandboxProcess {
      const terminate = new AbortController();
      let resolveKilled: (code: null) => void = () => {};
      const killed = new Promise<null>((resolve) => {
        resolveKilled = resolve;
      });
      const job = JSON.parse(readFileSync(spec.command.at(-1) ?? "", "utf8")) as VmJob;
      const vm: FakeVm = {
        spec,
        emit: (line) => {
          if (!vm.killed) onLine(line);
        },
        terminated: terminate.signal,
        killed: false,
        job: () => job,
      };
      vms.push(vm);
      return {
        exited: Promise.race([behaviour(vm), killed]),
        terminate: () => terminate.abort(),
        kill: () => {
          vm.killed = true;
          resolveKilled(null);
        },
      };
    },
  };
}

/** The real VM entry, in process: mounts become symlinks, the spec's env is the run's whole
 * environment. */
export const inProcessVm: FakeBehaviour = async (vm) => {
  for (const mount of vm.spec.mounts) {
    if (mount.guestPath === mount.hostPath) continue;
    mkdirSync(dirname(mount.guestPath), { recursive: true });
    symlinkSync(mount.hostPath, mount.guestPath);
  }
  await runVmJob(vm.job(), { env: vm.spec.env, writeLine: vm.emit, signal: vm.terminated });
  return 0;
};
