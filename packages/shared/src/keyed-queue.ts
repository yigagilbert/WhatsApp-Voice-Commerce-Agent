/**
 * Runs tasks one at a time per key, in arrival order; different keys never wait for each other.
 * One chat's messages must not overlap (they would lose cart updates and reorder replies), while a
 * slow LLM call for one customer must not delay another.
 */
export class KeyedQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task, task);
    const tail = result.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  /** Keys with work queued or running (for tests and metrics). */
  get size() {
    return this.tails.size;
  }
}
