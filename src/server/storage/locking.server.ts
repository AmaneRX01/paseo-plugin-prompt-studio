type AsyncLockRelease = () => Promise<void>;

/** Serializes same-key work in-process and composes it with a durable lock. */
export class KeyedLockQueue {
  private readonly pending = new Map<string, Promise<void>>();

  async run<T>(
    key: string,
    acquire: () => Promise<AsyncLockRelease>,
    operation: () => Promise<T>,
  ): Promise<T> {
    const prior = this.pending.get(key) ?? Promise.resolve();
    let releaseQueue!: () => void;
    const queued = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    const chain = prior.then(() => queued);
    this.pending.set(key, chain);
    await prior;
    let releaseFile: AsyncLockRelease | null = null;
    try {
      releaseFile = await acquire();
      return await operation();
    } finally {
      try {
        if (releaseFile) await releaseFile();
      } finally {
        releaseQueue();
        if (this.pending.get(key) === chain) this.pending.delete(key);
      }
    }
  }
}
