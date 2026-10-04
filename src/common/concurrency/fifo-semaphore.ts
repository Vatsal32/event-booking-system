/** Thrown by FifoSemaphore.acquire() when no slot frees up within the timeout. */
export class SemaphoreTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`No slot became free within ${timeoutMs}ms`);
    this.name = 'SemaphoreTimeoutError';
  }
}

interface Waiter {
  grant: (release: () => void) => void;
  timer: NodeJS.Timeout;
}

/**
 * At most `slots` holders at a time; everyone else waits in arrival order. A waiter that times
 * out is removed from the queue, so it never takes a slot later.
 */
export class FifoSemaphore {
  private available: number;
  private readonly waiters: Waiter[] = [];

  constructor(slots: number) {
    if (!Number.isInteger(slots) || slots < 1) {
      throw new Error(`FifoSemaphore needs at least 1 slot, got ${slots}`);
    }
    this.available = slots;
  }

  /** Resolves with a release function (call it exactly once), or rejects with SemaphoreTimeoutError. */
  acquire(timeoutMs: number): Promise<() => void> {
    if (this.available > 0) {
      this.available--;
      return Promise.resolve(this.makeRelease());
    }

    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        grant: resolve,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) this.waiters.splice(index, 1);
          reject(new SemaphoreTimeoutError(timeoutMs));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        // hand the slot straight to the next waiter
        clearTimeout(next.timer);
        next.grant(this.makeRelease());
      } else {
        this.available++;
      }
    };
  }
}
