/** Times each stage of handling one message, for the "message processed" log line. */
export class StageClock {
  private readonly started = performance.now();
  private last = this.started;
  private readonly marks: Record<string, number> = {};

  /** Records the time since the previous mark under `stage`. */
  mark(stage: string) {
    const now = performance.now();
    this.marks[stage] = Math.round(now - this.last);
    this.last = now;
  }

  stages() {
    return { ...this.marks };
  }

  total() {
    return Math.round(performance.now() - this.started);
  }
}

/** Rejects if `work` hasn't finished in time. The work itself keeps running. */
export function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
