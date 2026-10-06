/** A held VM slot; `release` frees it for the next waiter and is idempotent. */
export type ReleaseSlot = () => void;

/** A launch's place in the queue: `slot` resolves once it holds a slot, or with `null` when
 * `cancel` took it out of the queue first (a no-op once the slot is held). */
export interface SlotTicket {
  slot: Promise<ReleaseSlot | null>;
  cancel(): void;
}

/** The host-wide cap on running VMs (ADR 0091): every user's runs share it, first come first
 * served. */
export interface VmSlots {
  take(): SlotTicket;
}

export function createVmSlots(max: number): VmSlots {
  let running = 0;
  const queue: (() => void)[] = [];

  function grant(resolve: (release: ReleaseSlot) => void): void {
    running++;
    let released = false;
    resolve(() => {
      if (released) return;
      released = true;
      running--;
      queue.shift()?.();
    });
  }

  return {
    take() {
      let cancel = (): void => {};
      const slot = new Promise<ReleaseSlot | null>((resolve) => {
        if (running < max) return grant(resolve);
        const waiter = (): void => grant(resolve);
        queue.push(waiter);
        cancel = () => {
          const at = queue.indexOf(waiter);
          if (at < 0) return;
          queue.splice(at, 1);
          resolve(null);
        };
      });
      return { slot, cancel: () => cancel() };
    },
  };
}
