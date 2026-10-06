/**
 * The thin seam a hosted run's VM is started through (ADR 0091): Apple `container` in production,
 * Docker or OrbStack as the fallback, a fake in tests.
 */
export interface SandboxRuntime {
  /** Starts one VM; `onLine` receives each line the VM's process writes to stdout. */
  launch(spec: SandboxSpec, onLine: (line: string) => void): SandboxProcess;
}

/** A host directory the VM sees at `guestPath`. */
export interface SandboxMount {
  hostPath: string;
  guestPath: string;
  readOnly: boolean;
}

export interface SandboxSpec {
  /** Unique per VM, so a stop can name it. */
  name: string;
  /** Labels a reaper finds orphan VMs by. */
  labels: { [key: string]: string };
  image: string;
  /** The process the VM runs; the VM exits when it exits. */
  command: string[];
  mounts: SandboxMount[];
  /** The VM's whole environment: nothing of the host's leaks in beyond these. */
  env: { [name: string]: string };
  cpus: number;
  memoryMiB: number;
  /** The `container` network the VM joins; the runtime's default when absent. */
  network?: string;
}

export interface SandboxProcess {
  /** The VM process's exit code, `null` when it was killed or never started. Never rejects. */
  readonly exited: Promise<number | null>;
  /** Asks the engine inside to stop (SIGTERM), so it can still export its rows. */
  terminate(): void;
  /** Stops the VM at once. */
  kill(): void;
}
