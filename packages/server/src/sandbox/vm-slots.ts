/** A held VM slot; `release` frees it for the next waiter and is idempotent. */
export type ReleaseSlot = () => void;

/** A launch's place in the queue: `slot` resolves once it holds a slot, or with `null` when
 * `cancel` took it out of the queue first (a no-op once the slot is held). */
export interface SlotTicket {
  slot: Promise<ReleaseSlot | null>;
  cancel(): void;
}

/** The host-wide cap on running VMs (ADR 0091), shared by every user's runs. A free slot goes to
 * the oldest waiting launch whose user is under their own cap (docs/spec/path-website.md §8). */
export interface VmSlots {
  /** Queue a launch of `userId`, who may hold at most `perUser` slots at once. */
  take(userId?: string, perUser?: number): SlotTicket;
}

interface Waiter {
  userId: string;
  perUser: number;
  grant(): void;
}

export function createVmSlots(max: number): VmSlots {
  let running = 0;
  const runningBy = new Map<string, number>();
  const queue: Waiter[] = [];

  const held = (userId: string): number => runningBy.get(userId) ?? 0;

  /** Start every waiter that fits, oldest first. */
  function pump(): void {
    for (let i = 0; i < queue.length && running < max; ) {
      const waiter = queue[i] as Waiter;
      if (held(waiter.userId) >= waiter.perUser) {
        i++;
        continue;
      }
      queue.splice(i, 1);
      waiter.grant();
    }
  }

  return {
    take(userId = "", perUser = Number.POSITIVE_INFINITY) {
      let cancel = (): void => {};
      const slot = new Promise<ReleaseSlot | null>((resolve) => {
        const waiter: Waiter = {
          userId,
          perUser,
          grant() {
            running++;
            runningBy.set(userId, held(userId) + 1);
            let released = false;
            resolve(() => {
              if (released) return;
              released = true;
              running--;
              const left = held(userId) - 1;
              if (left > 0) runningBy.set(userId, left);
              else runningBy.delete(userId);
              pump();
            });
          },
        };
        queue.push(waiter);
        cancel = () => {
          const at = queue.indexOf(waiter);
          if (at < 0) return;
          queue.splice(at, 1);
          resolve(null);
        };
        pump();
      });
      return { slot, cancel: () => cancel() };
    },
  };
}
